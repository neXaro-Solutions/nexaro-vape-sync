import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEuro,extractDealerPrice} from './price.mjs';

test('German price formats and invalid basket values',()=>{
  assert.equal(parseEuro('1.140,00 €'),1140);
  assert.equal(parseEuro('47,25 €'),47.25);
  assert.equal(parseEuro('0,00 €'),null);
  assert.equal(parseEuro('Individueller Preis'),null);
});
test('does not read header cart or recommended products',()=>{
  const r=extractDealerPrice({
    title:'EASY OWL POD KIT',
    body:'KOSTENLOSER VERSAND\n0,00 €\nEASY OWL POD KIT\nblack-carbon\nab 1 Stück\n8,00 €\nUVP: 16,95 €\nIN DEN WARENKORB\nEMPFEHLUNG\n1,00 €'
  });
  assert.equal(r.priceCandidate,8);
  assert.equal(r.priceSource,'detail_tier_1');
  assert.equal(r.netBasisVerified,false);
});
test('variant bundles need review even if from price is captured',()=>{
  const r=extractDealerPrice({
    title:'PROMO BUNDLE',
    listingPrice:'ab 47,25 €',
    body:'PROMO BUNDLE\nBUNDLE\nab 47,25 €\nSORTE\nBitte auswählen\nPOD - 5,95 €\nIN DEN WARENKORB'
  });
  assert.equal(r.priceCandidate,47.25);
  assert.equal(r.priceStatus,'requires_variant_or_tier_review');
});
test('individual price is captured but not automatically authorized',()=>{
  const r=extractDealerPrice({
    title:'LOST MARY POD',
    listingPrice:'Individueller Preis',
    body:'LOST MARY POD\nINDIVIDUELLER PREIS\nab 1 Stück\n4,75 €\nUVP: 10,99 €\nIN DEN WARENKORB'
  });
  assert.equal(r.priceCandidate,4.75);
  assert.equal(r.priceStatus,'requires_variant_or_tier_review');
});
test('missing product price does not turn basket zero into EK',()=>{
  const r=extractDealerPrice({title:'UNPRICED',body:'0,00 €\nUNPRICED\nUVP: 10,99 €\nIN DEN WARENKORB'});
  assert.equal(r.priceCandidate,null);
  assert.equal(r.priceStatus,'missing');
});
