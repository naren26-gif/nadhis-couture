// SKU suggestions. Existing SKUs look like  UMRC-M-LV  =  <product+fabric letters>-<size>-<colour code>.
// We copy what the shop already uses when we can, and fall back to a simple rule for anything new.

function initials(text) {
  return String(text)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase())
    .join('');
}

// One word: first letter + first consonant after it + last consonant: Black -> BLK, Maroon -> MRN, Orange -> ORG.
// Two or more words use their initials: Light brown -> LB.
export function colourCodeFallback(colour) {
  const words = String(colour).trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return initials(colour).slice(0, 3);
  const upper = (words[0] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const consonants = [...upper.slice(1)].filter((letter) => !'AEIOU'.includes(letter));
  if (consonants.length < 2) return upper[0] + consonants.join('');
  return upper[0] + consonants[0] + consonants.at(-1);
}

export function prefixFallback(productName, fabric) {
  return initials(productName) + initials(fabric);
}

// existing = rows { sku, product_id, fabric, size, colour } for ALL variants (used to copy conventions)
export function suggestSku({ productId, productName, fabric, size, colour }, existing) {
  const sizeCode = String(size).toUpperCase();

  // prefix: what other variants of this product+fabric already use (the part before -SIZE-COLOUR)
  let prefix = null;
  const sibling = existing.find((v) => v.product_id === productId && v.fabric === fabric);
  if (sibling) {
    const tail = `-${sibling.size.toUpperCase()}-`;
    const at = sibling.sku.indexOf(tail);
    if (at > 0) prefix = sibling.sku.slice(0, at);
  }
  if (!prefix) prefix = prefixFallback(productName, fabric);

  // colour code: the one already used for this colour anywhere, else the rule
  let colourCode = null;
  const withColour = existing.find((v) => v.colour === colour);
  if (withColour) {
    const tail = withColour.sku.split('-').pop();
    if (tail) colourCode = tail;
  }
  if (!colourCode) colourCode = colourCodeFallback(colour);

  const base = `${prefix}-${sizeCode}-${colourCode}`;
  const taken = new Set(existing.map((v) => v.sku.toUpperCase()));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
