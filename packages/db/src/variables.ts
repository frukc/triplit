import {
  isFilterGroup,
  isFilterStatement,
  isRelationshipExistsFilter,
  isSubQueryFilter,
} from './filters.js';
import {
  CollectionQuery,
  FilterGroup,
  FilterStatement,
  PreparedWhere,
  PreparedWhereFilter,
  QueryWhere,
} from './query/types/index.js';
import { iterFromIndex } from './utils/iterators.js';
import { ValuePointer } from './utils/value-pointer.js';

const VARIABLE_SCOPES = new Set([
  '$global',
  '$session',
  '$token',
  '$role',
  '$query',
  '$prev',
]);

type VariableComponents = [scope: string | number | undefined, ...string[]];

// TODO: properly integrate this
// Should be friendly types that we pass into queries
// Not to be confused with the Value type that we store in the triple store
type QueryValue =
  | number
  | string
  | boolean
  | Date
  | null
  | number[]
  | boolean[]
  | string[]
  | Date[];

export function isValueVariable(value: QueryValue): value is string {
  return typeof value === 'string' && value[0] === '$';
}

// TODO: check variable[0] === '$'?
export function getVariableComponents(variable: string): VariableComponents {
  const components = variable.split('.') as VariableComponents;
  if (components.length < 1) throw new Error(`Invalid variable: ${variable}`);

  // if the variable has only one component, we assume it's a non-scoped variable
  if (components.length === 1) {
    components.unshift(undefined);
    components[1] = components[1].slice(1); // remove the '$'
    return components;
  }

  // For backwards compatability, we allow non-scoped variables
  const parsedScope = parseVarScope(components[0] as string);
  if (parsedScope === undefined) {
    components.unshift(undefined);
    components[1] = components[1].slice(1); // remove the '$'
    return components;
  } else {
    components[0] = parsedScope;
    return components;
  }
}

function parseVarScope(scope: string): string | number | undefined {
  if (VARIABLE_SCOPES.has(scope)) {
    if (scope === '$token') return '$session';
    return scope;
  }
  const numParsed = parseInt(scope.slice(1), 10);
  if (!isNaN(numParsed)) return numParsed;
  return undefined;
}

export function varScopeType(scope: string): string {
  if (!isNaN(parseInt(scope))) return 'relational';
  return scope;
}

export function isVariableScopeRelational(
  scope: string | number | undefined
): scope is number {
  return typeof scope === 'number';
}

/**
 * Given a variable, if the variable is referential, increment the scope by 1, otherwise return the variable unchanged.
 */
export function safeIncrementSubqueryVar(
  varName: string,
  step: number = 1
): string {
  if (!isValueVariable(varName)) return varName;
  const components = getVariableComponents(varName);
  const scope = components[0];
  if (isVariableScopeRelational(scope)) {
    return `$${scope + step}.${components.slice(1).join('.')}`;
  }
  return varName;
}

function safeIncrementQueryWhere(
  where: QueryWhere,
  step: number = 1
): QueryWhere {
  const newWhere: QueryWhere = [];
  for (const filter of where) {
    // Filter statement, filter group, filter subquery, relationship exists(?)
    if (isFilterStatement(filter)) {
      let [prop, op, val] = filter;
      val = safeIncrementSubqueryVar(val as string, step);
      newWhere.push([prop, op, val]);
      continue;
    }
    if (isFilterGroup(filter)) {
      newWhere.push({
        ...filter,
        filters: safeIncrementQueryWhere(filter.filters, step),
      });
      continue;
    }
    if (isSubQueryFilter(filter)) {
      newWhere.push({ exists: safeIncrementQueryVars(filter.exists, step) });
      continue;
    }
    if (isRelationshipExistsFilter(filter)) {
      newWhere.push({
        exists: {
          ...filter.exists,
          where: filter.exists.where
            ? safeIncrementQueryWhere(filter.exists.where, step)
            : undefined,
        },
      });
    }
    newWhere.push(filter);
  }
  return newWhere;
}

export function safeIncrementQueryVars(
  query: CollectionQuery,
  step: number = 1
): CollectionQuery {
  if (!query.where) return query;
  return { ...query, where: safeIncrementQueryWhere(query.where, step) };
}

export function resolveVariable(variable: string, vars: any): any {
  if (variable in vars) {
    return vars[variable];
  }
  const [scope, ...path] = getVariableComponents(variable);
  if (typeof scope === 'number') {
    const relativeDepth = scope;
    if (!vars.entityStack || vars.entityStack.length < relativeDepth) {
      throw new Error(
        `Variable reference is out of bounds. Tried to find ${variable} in stack of size ${vars.entityStack?.length}`
      );
    }
    // Use entityStack: $1 gives last, $2 gives parent's parent, etc.
    return ValuePointer.Get(
      vars.entityStack[vars.entityStack.length - relativeDepth],
      path
    );
  }
  // $view_{id} vars handled as a special case
  if (scope === undefined && path[0].startsWith('view_')) {
    const view = vars[path[0]];
    if (!view) throw new Error(`View ${path[0]} not found in vars`);
    if (!Array.isArray(view))
      throw new Error(`View ${path[0]} is not an array`);
    return view.map((item) => ValuePointer.Get(item, iterFromIndex(path, 1)));
  }
  const resolvedVal = ValuePointer.Get(vars, path);
  // TODO should we throw an error here if undefined?
  return resolvedVal;
}

export function bindVariablesInFilters<W extends PreparedWhere>(
  filters: W,
  vars: any
): W {
  return filters.map((filter) => bindVariablesInFilter(filter, vars)) as W;
}

export function bindVariablesInFilter<W extends PreparedWhereFilter>(
  filter: W,
  vars: any
): W {
  if (isFilterGroup(filter)) {
    return {
      mod: filter.mod,
      filters: bindVariablesInFilters(filter.filters, vars),
    } as W;
  }
  if (isFilterStatement(filter) && isValueVariable(filter[2])) {
    const variable = filter[2] as string;
    let resolvedValue = resolveVariable(variable, vars);
    // Theres a few things going on here to be untangled and refactored:
    // 1. Transforming arrays to sets for improved lookup performance
    // 2. $view_{id} variables are returned as arrays, we have some special handling for arrays of encoded sets
    // For (2), we should figure out a better way to encode lhs and rhs data types operands on filters so we know what we are dealing with
    if (Array.isArray(resolvedValue)) {
      const resolvedSet = new Set();
      for (const val of resolvedValue) {
        if (typeof val === 'object' && val !== null) {
          // this is assumed to be an internal set (dangerously)
          for (const [setVal, isAlive] of Object.entries(val)) {
            if (isAlive) resolvedSet.add(setVal);
          }
        } else {
          resolvedSet.add(val);
        }
      }
      resolvedValue = resolvedSet;
    }
    return [filter[0], filter[1], resolvedValue] as FilterStatement as W;
  }
  return filter;
}
