import { parse } from 'acorn';

/** Returns acorn's error if source isn't plain ES5, or null if it parses. */
export function es5SyntaxError(source) {
  try {
    parse(source, { ecmaVersion: 5 });
    return null;
  } catch (err) {
    return err;
  }
}

export default {
  meta: { name: 'es5' },
  rules: {
    syntax: {
      meta: {
        type: 'problem',
        docs: { description: 'Require syntax that parses as plain ES5' },
      },
      create(context) {
        return {
          Program(node) {
            const err = es5SyntaxError(context.sourceCode.text);
            if (err) {
              context.report({
                node,
                loc: err.loc ?? node.loc,
                message: `Not ES5: ${err.message.replace(/ \(\d+:\d+\)$/, '')}`,
              });
            }
          },
        };
      },
    },
  },
};
