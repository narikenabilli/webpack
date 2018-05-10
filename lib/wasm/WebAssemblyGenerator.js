/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/
"use strict";

const Generator = require("../Generator");
const Template = require("../Template");
const WebAssemblyImportDependency = require("../dependencies/WebAssemblyImportDependency");
const { RawSource } = require("webpack-sources");

const { editWithAST, addWithAST } = require("@webassemblyjs/wasm-edit");
const { decode } = require("@webassemblyjs/wasm-parser");
const t = require("@webassemblyjs/ast");

function compose(...fns) {
	return fns.reduce((prevFn, nextFn) => {
		return value => nextFn(prevFn(value));
	}, value => value);
}

// Utility functions

/**
 * @param {t.ModuleImport} n the import
 * @returns {boolean} true, if a global was imported
 */
const isGlobalImport = n => n.descr.type === "GlobalType";

/**
 * @param {t.ModuleImport} n the import
 * @returns {boolean} true, if a func was imported
 */
const isFuncImport = n => n.descr.type === "FuncImportDescr";

// TODO replace with @callback
/**
 * @typedef {(ArrayBuffer) => ArrayBuffer} ArrayBufferTransform
 */

/**
 * Removes the start instruction
 *
 * @param {Object} state - unused state
 * @returns {ArrayBufferTransform} transform
 */
const removeStartFunc = state => bin => {
	return editWithAST(state.ast, bin, {
		Start(path) {
			path.remove();
		}
	});
};

/**
 * Retrieve the start function
 *
 * @param {Object} ast - Module's AST
 * @returns {t.Identifier | undefined} - node if any
 */
function getStartFuncIndex(ast) {
	let startAtFuncIndex;

	t.traverse(ast, {
		Start({ node }) {
			startAtFuncIndex = node.index;
		}
	});

	return startAtFuncIndex;
}

/**
 * Get imported globals
 *
 * @param {Object} ast - Module's AST
 * @returns {Array<t.ModuleImport>} - nodes
 */
function getImportedGlobals(ast) {
	const importedGlobals = [];

	t.traverse(ast, {
		ModuleImport({ node }) {
			if (isGlobalImport(node) === true) {
				importedGlobals.push(node);
			}
		}
	});

	return importedGlobals;
}

function getCountImportedFunc(ast) {
	let count = 0;

	t.traverse(ast, {
		ModuleImport({ node }) {
			if (isFuncImport(node) === true) {
				count++;
			}
		}
	});

	return count;
}

/**
 * Get next type index
 *
 * @param {Object} ast - Module's AST
 * @returns {t.IndexLiteral} - index
 */
function getNextTypeIndex(ast) {
	const typeSectionMetadata = t.getSectionMetadata(ast, "type");

	if (typeof typeSectionMetadata === "undefined") {
		return t.indexLiteral(0);
	}

	return t.indexLiteral(typeSectionMetadata.vectorOfSize.value);
}

/**
 * Get next func index
 *
 * The Func section metadata provide informations for implemented funcs
 * in order to have the correct index we shift the index by number of external
 * functions.
 *
 * @param {Object} ast - Module's AST
 * @param {Number} countImportedFunc - number of imported funcs
 * @returns {t.IndexLiteral} - index
 */
function getNextFuncIndex(ast, countImportedFunc) {
	const funcSectionMetadata = t.getSectionMetadata(ast, "func");

	if (typeof funcSectionMetadata === "undefined") {
		return t.indexLiteral(0 + countImportedFunc);
	}

	const vectorOfSize = funcSectionMetadata.vectorOfSize.value;

	return t.indexLiteral(vectorOfSize + countImportedFunc);
}

/**
 * Rewrite the import globals:
 * - removes the ModuleImport instruction
 * - injects at the same offset a mutable global of the same time
 *
 * Since the imported globals are before the other global declarations, our
 * indices will be preserved.
 *
 * Note that globals will become mutable.
 *
 * @param {Object} state - unused state
 * @returns {ArrayBufferTransform} transform
 */
const rewriteImportedGlobals = state => bin => {
	const newGlobals = [];

	bin = editWithAST(state.ast, bin, {
		ModuleImport(path) {
			if (isGlobalImport(path.node) === true) {
				const globalType = path.node.descr;

				globalType.mutability = "var";

				newGlobals.push(
					t.global(globalType, [
						t.objectInstruction("const", "i32", [t.numberLiteral(0)])
					])
				);

				path.remove();
			}
		}
	});

	// Add global declaration instructions
	return addWithAST(state.ast, bin, newGlobals);
};

/**
 * Rewrite the export names
 * @param {Object} state state
 * @param {Object} state.ast Module's ast
 * @param {Object} state.module Module
 * @returns {ArrayBufferTransform} transform
 */
const rewriteExportNames = ({ ast, module }) => bin => {
	return editWithAST(ast, bin, {
		ModuleExport(path) {
			const usedName = module.isUsed(path.node.name);
			if (usedName) {
				path.node.name = usedName;
				// TODO remove this when fixed in @webassemblyjs
				path.node.descr.id = t.numberLiteral(+path.node.descr.id.raw);
			} else {
				path.remove();
			}
		}
	});
};

const rewriteImports = state => bin => {
	const importMangleMap = state.importMangleMap;
	return edit(bin, {
		ModuleImport(path) {
			const result = importMangleMap.get(
				path.node.module + ":" + path.node.name
			);
			if (result === undefined) {
				path.remove();
			} else {
				path.node.module = "a";
				path.node.name = result;
				if (path.node.descr.id)
					path.node.descr.id = t.numberLiteral(+path.node.descr.id.raw);
				if (path.node.descr.name)
					path.node.descr.name = t.numberLiteral(+path.node.descr.name.raw);
			}
		}
	});
};

/**
 * Add an init function.
 *
 * The init function fills the globals given input arguments.
 *
 * @param {Object} state transformation state
 * @param {Object} state.ast - Module's ast
 * @param {t.Identifier} state.initFuncId identifier of the init function
 * @param {t.IndexLiteral} state.startAtFuncIndex index of the start function
 * @param {t.ModuleImport[]} state.importedGlobals list of imported globals
 * @param {t.IndexLiteral} state.nextFuncIndex index of the next function
 * @param {t.IndexLiteral} state.nextTypeIndex index of the next type
 * @returns {ArrayBufferTransform} transform
 */
const addInitFunction = ({
	ast,
	initFuncId,
	startAtFuncIndex,
	importedGlobals,
	nextFuncIndex,
	nextTypeIndex
}) => bin => {
	const funcParams = importedGlobals.map(importedGlobal => {
		// used for debugging
		const id = t.identifier(`${importedGlobal.module}.${importedGlobal.name}`);

		return t.funcParam(importedGlobal.descr.valtype, id);
	});

	const funcBody = importedGlobals.reduce((acc, importedGlobal, index) => {
		const args = [t.indexLiteral(index)];
		const body = [
			t.instruction("get_local", args),
			t.instruction("set_global", args)
		];

		return [...acc, ...body];
	}, []);

	if (typeof startAtFuncIndex !== "undefined") {
		funcBody.push(t.callInstruction(startAtFuncIndex));
	}

	const funcResults = [];

	// Code section
	const func = t.func(initFuncId, funcParams, funcResults, funcBody);

	// Type section
	const functype = t.typeInstructionFunc(
		func.signature.params,
		func.signature.results
	);

	// Func section
	const funcindex = t.indexInFuncSection(nextTypeIndex);

	// Export section
	const moduleExport = t.moduleExport(initFuncId.value, "Func", nextFuncIndex);

	return addWithAST(ast, bin, [func, moduleExport, funcindex, functype]);
};

const getImportMangleMap = module => {
	/** @type {Map<string,string>} */
	const map = new Map();
	let importIndex = 0;
	for (const dep of module.dependencies) {
		if (dep instanceof WebAssemblyImportDependency) {
			if (dep.description.type === "GlobalType" || dep.module === null) {
				continue;
			}

			const importedModule = dep.module;
			const request = dep.request;
			const exportName = dep.name;
			const usedName = importedModule && importedModule.isUsed(exportName);
			if (usedName !== false) {
				map.set(
					request + ":" + exportName,
					Template.numberToIdentifer(importIndex++)
				);
			}
		}
	}
	return map;
};

class WebAssemblyGenerator extends Generator {
	generate(module) {
		const bin = module.originalSource().source();

		const initFuncId = t.identifier(
			Array.isArray(module.usedExports)
				? Template.numberToIdentifer(module.usedExports.length)
				: "__webpack_init__"
		);

		const ast = decode(bin, {
			ignoreDataSection: true,
			ignoreCodeSection: true
		});

		const importedGlobals = getImportedGlobals(ast);
		const countImportedFunc = getCountImportedFunc(ast);
		const startAtFuncIndex = getStartFuncIndex(ast);
		const nextFuncIndex = getNextFuncIndex(ast, countImportedFunc);
		const nextTypeIndex = getNextTypeIndex(ast);

		const importMangleMap = getImportMangleMap(module);

		const transform = compose(
			rewriteExportNames({
				ast,
				module
			}),

			removeStartFunc({ ast }),

			rewriteImportedGlobals({ ast }),

			rewriteImports({
				importMangleMap
			}),

			addInitFunction({
				ast,
				initFuncId,
				importedGlobals,
				startAtFuncIndex,
				nextFuncIndex,
				nextTypeIndex
			})
		);

		const newBin = transform(bin);

		return new RawSource(newBin);
	}
}

module.exports = WebAssemblyGenerator;