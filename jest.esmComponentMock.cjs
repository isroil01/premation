/**
 * Stub for ESM-only render-time dependencies (react-markdown and its remark /
 * micromark tree).
 *
 * Those packages ship ESM only, and this suite runs as CommonJS, so importing
 * one anywhere in a component tree fails the whole file at parse time with
 * "Unexpected token 'export'". That is what stopped the editor from being
 * mountable in a test at all.
 *
 * Renders its children so layout still resolves. Nothing under test asserts on
 * markdown OUTPUT — if something ever does, it needs the real package and a
 * transform exception, not this.
 */

const React = require('react');

module.exports = function EsmComponentStub(props) {
  return React.createElement('div', { 'data-esm-stub': true }, props && props.children);
};
module.exports.default = module.exports;
