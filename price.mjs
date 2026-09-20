/**
 * Extract product-level dealer price without confusing basket, UVP, related
 * products, variant options or quantity-tier prices with a fixed unit price.
 * A price candidate is NOT a confirmed net purchase price or an offer price.
 */
export function parseEuro(value) {
  const match=String(value ?? '').match(/(\d{1,3}(?:[.\s]\d{3})*|\d+),(\d{2})\s*€/);
  if(!match) return null;
  const euros=match[1].replace(/[.\s]/g,'');
  const amount=Number(euros+'.'+match[2]);
  return Number.isFinite(amount)&&amount>0?amount:null;
}
export function extractDealerPrice({body='',title='',listingPrice=''}={}) {
  const text=String(body).replace(/\u00a0/g,' ');
  const heading=title?text.toLocaleLowerCase('de-DE').indexOf(String(title).toLocaleLowerCase('de-DE')):-1;
  // Start at the actual product heading, never at the header basket.
  const section=heading>=0?text.slice(heading):'';
  const cart=section.search(/\bIN DEN WARENKORB\b|\bAUSWAHL IN DEN WARENKORB\b/i);
  const own=(cart>=0?section.slice(0,cart):section.slice(0,1200)).slice(0,9000);
  const pricePattern='(?:\\d{1,3}(?:[.\\s]\\d{3})*|\\d+),\\d{2}\\s*€';
  const tier=new RegExp('\\bab\\s*1\\s*St[üu]ck\\s*('+pricePattern+')','i').exec(own);
  const ranged=new RegExp('\\bab\\s*('+pricePattern+')','i').exec(own);
  const mainPrice=new RegExp('(?:^|\\n)\\s*('+pricePattern+')\\s*(?:\\n|$)','i').exec(own);
  let value=tier?.[1]||ranged?.[1]||mainPrice?.[1]||'';
  let source=tier?'detail_tier_1':ranged?'detail_from':mainPrice?'detail_main':'missing';
  if(!value && listingPrice) {
    const m=new RegExp(pricePattern,'i').exec(listingPrice);
    if(m){value=m[0];source=/\bab\b/i.test(listingPrice)?'listing_from':'listing';}
  }
  const price=parseEuro(value);
  const hasVariants=/\b(Bitte auswählen|SORTE|FARBE|WIDERSTAND|NIKOTINMENGE)\b/i.test(own);
  const individualized=/INDIVIDUELLER PREIS/i.test(own)||/INDIVIDUELLER PREIS/i.test(listingPrice);
  const isFrom=source.endsWith('_from');
  return {
    priceCandidate:price,
    priceText:value||null,
    priceSource:source,
    priceStatus:price===null?'missing':(isFrom||hasVariants||individualized?'requires_variant_or_tier_review':'unit_price_candidate'),
    hasVariants,
    individualized,
    // Do not claim net VAT basis just from the display value.
    netBasisVerified:false,
  };
}
