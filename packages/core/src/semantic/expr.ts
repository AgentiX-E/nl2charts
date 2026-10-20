/**
 * Arithmetic over metric references. Deliberately tiny: `+ - * /`, parentheses,
 * numeric literals and metric names. Anything else is rejected, because the
 * expression is embedded in generated SQL.
 */
export type ExprAst =
  | { readonly type: 'ref'; readonly name: string }
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'binary'; readonly op: '+' | '-' | '*' | '/'; readonly left: ExprAst; readonly right: ExprAst };

type Token = { readonly type: 'name' | 'number' | 'op' | 'paren'; readonly value: string };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      let end = index;
      while (end < text.length && /[0-9.]/.test(text.charAt(end))) end += 1;
      tokens.push({ type: 'number', value: text.slice(index, end) });
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index;
      while (end < text.length && /[A-Za-z0-9_]/.test(text.charAt(end))) end += 1;
      tokens.push({ type: 'name', value: text.slice(index, end) });
      index = end;
      continue;
    }
    if ('+-*/'.includes(char)) {
      tokens.push({ type: 'op', value: char });
      index += 1;
      continue;
    }
    if (char === '(' || char === ')') {
      tokens.push({ type: 'paren', value: char });
      index += 1;
      continue;
    }
    throw new Error(`unexpected character ${char}`);
  }
  return tokens;
}

export function parseMetricExpr(text: string): ExprAst {
  const tokens = tokenize(text);
  let position = 0;

  const peek = (): Token | undefined => tokens[position];
  const next = (): Token => {
    const token = tokens[position];
    if (!token) throw new Error('unexpected end of expression');
    position += 1;
    return token;
  };

  const parsePrimary = (): ExprAst => {
    const token = next();
    if (token.type === 'number') {
      const value = Number(token.value);
      if (!Number.isFinite(value)) throw new Error(`bad number ${token.value}`);
      return { type: 'number', value };
    }
    if (token.type === 'name') return { type: 'ref', name: token.value };
    if (token.type === 'paren' && token.value === '(') {
      const inner = parseSum();
      const close = next();
      if (close.type !== 'paren' || close.value !== ')') throw new Error('missing closing parenthesis');
      return inner;
    }
    throw new Error(`unexpected token ${token.value}`);
  };

  const parseProduct = (): ExprAst => {
    let left = parsePrimary();
    while (peek()?.type === 'op' && (peek()?.value === '*' || peek()?.value === '/')) {
      const op = next().value as '*' | '/';
      left = { type: 'binary', op, left, right: parsePrimary() };
    }
    return left;
  };

  const parseSum = (): ExprAst => {
    let left = parseProduct();
    while (peek()?.type === 'op' && (peek()?.value === '+' || peek()?.value === '-')) {
      const op = next().value as '+' | '-';
      left = { type: 'binary', op, left, right: parseProduct() };
    }
    return left;
  };

  const ast = parseSum();
  if (position !== tokens.length) throw new Error('trailing tokens');
  return ast;
}

export function refsOf(ast: ExprAst): string[] {
  if (ast.type === 'ref') return [ast.name];
  if (ast.type === 'number') return [];
  return [...refsOf(ast.left), ...refsOf(ast.right)];
}
