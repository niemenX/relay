/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 */

'use strict';

const GraphQLIRTransformer = require('../core/GraphQLIRTransformer');

const {
  getRawType,
  isClientDefinedField,
} = require('../core/GraphQLSchemaUtils');
const {
  createCompilerError,
  createUserError,
} = require('../core/RelayCompilerError');

import type GraphQLCompilerContext from '../core/GraphQLCompilerContext';
import type {Definition, Node, Selection} from '../core/GraphQLIR';
import type {GraphQLType} from 'graphql';

type State = {|
  clientFields: Map<string, Selection>,
  parentType: GraphQLType | null,
|};

function clientExtensionTransform(
  context: GraphQLCompilerContext,
): GraphQLCompilerContext {
  return GraphQLIRTransformer.transform<State>(context, {
    Fragment: traverseDefintion,
    Root: traverseDefintion,
    SplitOperation: traverseDefintion,
  });
}

function traverseDefintion<T: Definition>(node: T): T {
  const compilerContext = this.getContext();
  const {serverSchema, clientSchema} = compilerContext;

  let rootType;
  switch (node.kind) {
    case 'Root':
      switch (node.operation) {
        case 'query':
          rootType = serverSchema.getQueryType();
          break;
        case 'mutation':
          rootType = serverSchema.getMutationType();
          break;
        case 'subscription':
          rootType = serverSchema.getSubscriptionType();
          break;
        default:
          (node.operation: empty);
      }
      break;
    case 'SplitOperation':
      rootType = serverSchema.getType(node.type.name);
      break;
    case 'Fragment':
      rootType =
        serverSchema.getType(node.type.name) ??
        clientSchema.getType(node.type.name);
      break;
    default:
      (node: empty);
  }
  if (rootType == null) {
    throw createUserError(
      `ClientExtensionTransform: Expected the type of \`${
        node.name
      }\` to have been defined in the schema. Make sure both server and ` +
        'client schema are up to date.',
      [node.loc],
    );
  }
  return traverseSelections(node, compilerContext, rootType);
}

function traverseSelections<T: Node>(
  node: T,
  compilerContext: GraphQLCompilerContext,
  parentType: GraphQLType,
): T {
  const {serverSchema, clientSchema} = compilerContext;
  const clientSelections = [];
  const serverSelections = [];
  node.selections.forEach(selection => {
    switch (selection.kind) {
      case 'ClientExtension': {
        serverSelections.push(selection);
        break;
      }
      case 'Condition':
      case 'Defer':
      case 'ModuleImport':
      case 'Stream': {
        const transformed = traverseSelections(
          selection,
          compilerContext,
          parentType,
        );
        serverSelections.push(transformed);
        break;
      }
      case 'ScalarField':
      case 'LinkedField': {
        const isClientField = isClientDefinedField(
          selection,
          compilerContext,
          parentType,
        );

        if (isClientField) {
          clientSelections.push(selection);
          break;
        }
        if (selection.kind === 'ScalarField') {
          serverSelections.push(selection);
        } else {
          const rawType = getRawType(selection.type);
          const fieldType =
            serverSchema.getType(rawType.name) ??
            clientSchema.getType(rawType.name);
          if (fieldType == null) {
            throw createCompilerError(
              'ClientExtensionTransform: Expected to be able to determine ' +
                `type of field \`${selection.name}\`.`,
              [selection.loc],
            );
          }
          const transformed = traverseSelections(
            selection,
            compilerContext,
            fieldType,
          );
          serverSelections.push(transformed);
        }
        break;
      }
      case 'InlineFragment': {
        const typeName = selection.typeCondition.name;
        const serverType = serverSchema.getType(typeName);
        const clientType = clientSchema.getType(typeName);
        const isClientType = serverType == null && clientType != null;

        if (isClientType) {
          clientSelections.push(selection);
        } else {
          const type = serverType ?? clientType;
          if (type == null) {
            throw createCompilerError(
              'ClientExtensionTransform: Expected to be able to determine ' +
                `type of inline fragment on \`${typeName}\`.`,
              [selection.loc],
            );
          }
          const transformed = traverseSelections(
            selection,
            compilerContext,
            type,
          );
          serverSelections.push(transformed);
        }
        break;
      }
      case 'FragmentSpread': {
        const fragment = compilerContext.getFragment(selection.name);
        const typeName = fragment.type.name;
        const serverType = serverSchema.getType(typeName);
        const clientType = clientSchema.getType(typeName);
        const isClientType = serverType == null && clientType != null;

        if (isClientType) {
          clientSelections.push(selection);
        } else {
          serverSelections.push(selection);
        }
        break;
      }
      default:
        (selection: empty);
        throw createCompilerError(
          `ClientExtensionTransform: Unexpected selection of kind \`${
            selection.kind
          }\`.`,
          [selection.loc],
        );
    }
  });
  if (clientSelections.length === 0) {
    // $FlowFixMe - TODO: type IRTransformer to allow changing result type
    return {
      ...node,
      selections: [...serverSelections],
    };
  }
  // $FlowFixMe - TODO: type IRTransformer to allow changing result type
  return {
    ...node,
    selections: [
      ...serverSelections,
      // Group client fields under a single ClientExtension node
      {
        kind: 'ClientExtension',
        loc: node.loc,
        metadata: null,
        selections: [...clientSelections],
      },
    ],
  };
}

module.exports = {
  transform: clientExtensionTransform,
};
