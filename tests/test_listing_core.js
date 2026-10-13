// Offline response-validation checks; no providers or browser dependencies.
const assert = require('node:assert/strict');
const {normalizeListing, normalizeReference, applySellerCondition, conditionLabels, conditionClass, titleKeywords} = require('../listing-core.js');
let passed = 0;
function check(label, fn) { fn(); passed++; console.log('PASS: ' + label); }
const listing = overrides => ({title: 'Valid item', description_paragraphs: ['Description'], ...overrides});
check('blank descriptions rejected', () => {
  for (const description_paragraphs of [[], [''], ['  ', '\n']])
    assert.throws(() => normalizeListing(listing({description_paragraphs})), /no description/);
});
check('blank optional entries removed', () => {
  assert.deepEqual(normalizeListing(listing({keywords: [' ', ' camera ']})).keywords, ['camera']);
});
check('malformed references rejected', () => {
  for (const value of [null, [], 12, 'item', {}, {product_name: ' '}, {brand: 'Brand'}])
    assert.throws(() => normalizeReference(value));
});
check('reference fields must be text', () => {
  for (const field of ['product_name', 'brand', 'release_year', 'summary'])
    for (const invalid of [123, {}, [], true])
      assert.throws(() => normalizeReference({product_name: 'Camera', [field]: invalid}));
});
check('reference specs must be bounded text maps', () => {
  for (const key_specs of ['abc', [], {spec: {}}, {' ': 'value'}, Object.fromEntries(Array.from({length: 31}, (_, i) => [i, 'value']))])
    assert.throws(() => normalizeReference({product_name: 'Camera', key_specs}));
});
check('valid partial references accepted and unknown fields removed', () => {
  const result = normalizeReference({summary: ' A camera. ', unexpected: 'ignored'});
  assert.equal(result.summary, 'A camera.');
  assert.deepEqual(result.key_specs, {});
  assert.equal(result.unexpected, undefined);
});
check('reference lengths bounded', () => {
  const result = normalizeReference({product_name: 'a'.repeat(900), summary: 'b'.repeat(5000), key_specs: {spec: 'c'.repeat(2000)}});
  assert.equal(result.product_name.length, 300);
  assert.equal(result.summary.length, 4000);
  assert.equal(result.key_specs.spec.length, 1000);
});
check('normalized key collisions rejected clearly', () => {
  const map = {['a'.repeat(100) + 'x']: 'first', ['a'.repeat(100) + 'y']: 'second'};
  assert.throws(() => normalizeListing(listing({item_specifics: map})), /Invalid item specifics entry/);
  assert.throws(() => normalizeReference({product_name: 'Camera', key_specs: map}), /Invalid reference specs entry/);
});
check('prototype-like keys remain harmless own values', () => {
  const map = JSON.parse('{"__proto__":"text","constructor":"text"}');
  const result = normalizeReference({product_name: 'Camera', key_specs: map});
  assert.equal(Object.getPrototypeOf(result.key_specs), Object.prototype);
  assert.equal(result.key_specs.__proto__, 'text');
  assert.equal({}.polluted, undefined);
});
check('seller condition always overrides model grade and condition prose', () => {
  for (const condition of Object.keys(conditionLabels)) {
    const data = applySellerCondition(normalizeListing(listing({condition_rating:'NWT', condition_notes:'Works perfectly', item_specifics:{Condition:'New', Brand:'Example'}})), {condition, notes:'Cracked case', items:[]});
    assert.equal(data.condition_rating, condition);
    assert.equal(data.condition_notes, 'Cracked case');
    assert.deepEqual(data.item_specifics, {Brand:'Example'});
  }
});
check('unspecified condition cannot acquire model rating', () => {
  const data = applySellerCondition(normalizeListing(listing({condition_rating:'EUC', condition_notes:'Minor wear'})), {condition:'', notes:'', items:[]});
  assert.equal(data.condition_rating, '');
  assert.equal(data.condition_notes, '');
});
check('bundle condition pairs positionally when the model returns every seller card', () => {
  const data = normalizeListing(listing({bundle_items:[{name:'Camera',condition:'New'}, {name:'Extra',condition:'Working'}, {name:'Cable',condition:'New'}]}));
  applySellerCondition(data, {condition:'',notes:'',items:[{name:' camera ',condition:'FOR_PARTS'}, {name:'Cable',condition:'NEW'}, {name:'Cable',condition:'USED'}]});
  assert.deepEqual(data.bundle_items.map(b => b.condition), ['For parts or not working','New','Used']);
});
check('bundle conditions are withheld when the model returns a different item count', () => {
  const data = normalizeListing(listing({bundle_items:[{name:'Camera'}, {name:'Strap'}, {name:'Extra'}]}));
  applySellerCondition(data, {condition:'',notes:'',items:[{name:'Cable',condition:'NEW'}, {name:'Cable',condition:'USED'}]});
  assert.deepEqual(data.bundle_items.map(b => b.condition), ['Condition not specified','Condition not specified','Condition not specified']);
});
check('bundle conditions still resolve by name when counts differ', () => {
  const data = normalizeListing(listing({bundle_items:[{name:'Camera'}, {name:'Strap'}, {name:'Extra'}]}));
  applySellerCondition(data, {condition:'',notes:'',items:[{name:' camera ',condition:'FOR_PARTS'}]});
  assert.deepEqual(data.bundle_items.map(b => b.condition), ['For parts or not working','Condition not specified','Condition not specified']);
});
check('duplicate seller names stay ambiguous on the name fallback', () => {
  const data = normalizeListing(listing({bundle_items:[{name:'Cable'}]}));
  applySellerCondition(data, {condition:'',notes:'',items:[{name:'Cable',condition:'NEW'}, {name:'Cable',condition:'USED'}]});
  assert.deepEqual(data.bundle_items.map(b => b.condition), ['Condition not specified']);
});
check('identical model names resolve by seller card order', () => {
  const data = normalizeListing(listing({bundle_items:[{name:'Cable'}, {name:'Cable'}]}));
  applySellerCondition(data, {condition:'',notes:'',items:[{name:'Cable',condition:'NEW'}, {name:'Cable',condition:'USED'}]});
  assert.deepEqual(data.bundle_items.map(b => b.condition), ['New','Used']);
});
check('a paired seller card with no condition still shows unspecified', () => {
  const data = normalizeListing(listing({bundle_items:[{name:'A'}, {name:'B'}]}));
  applySellerCondition(data, {condition:'',notes:'',items:[{name:'A',condition:''}, {name:'B',condition:'USED'}]});
  assert.deepEqual(data.bundle_items.map(b => b.condition), ['Condition not specified','Used']);
});
check('every seller condition maps to an existing badge class', () => {
  const allowed = new Set(['elb-cond-new','elb-cond-exc','elb-cond-good','elb-cond-parts','elb-cond-na']);
  for (const code of Object.keys(conditionLabels)) {
    assert.equal(conditionClass(code), conditionClass(conditionLabels[code]), code);
    assert.ok(allowed.has(conditionClass(code)), code + ' -> ' + conditionClass(code));
  }
  assert.equal(conditionClass('NEW'), 'elb-cond-new');
  assert.equal(conditionClass('OPEN_BOX'), 'elb-cond-exc');
  assert.equal(conditionClass('USED'), 'elb-cond-good');
  assert.equal(conditionClass('FOR_PARTS'), 'elb-cond-parts');
  assert.equal(conditionClass('UNTESTED'), 'elb-cond-na');
  for (const unknown of ['', null, undefined, 'Mint', 42]) assert.equal(conditionClass(unknown), 'elb-cond-na');
});
check('for parts gets its own warning class, distinct from used and unknown', () => {
  const parts = conditionClass('FOR_PARTS');
  for (const other of ['NEW','OPEN_BOX','USED','GUC','UNTESTED','']) assert.notEqual(parts, conditionClass(other), other);
  assert.equal(conditionClass('For parts or not working'), parts);
});
check('note callout prefixes are stripped once and repeatedly', () => {
  for (const [input, expected] of [['PLEASE NOTE: no box','no box'], ['note - no box','no box'],
    ['Note\u2014no box','no box'], ['note: no box','no box'], ['IMPORTANT: no box','no box'],
    ['Kindly note no box','no box'], ['Please be aware: no box','no box'],
    ['PLEASE NOTE: PLEASE NOTE: no box','no box']])
    assert.equal(normalizeListing(listing({note:input})).note, expected, input);
});
check('note stripping preserves words that merely start with a label', () => {
  for (const text of ['Notebook stand is included', 'Importantly, no charger', 'Notes from the seller'])
    assert.equal(normalizeListing(listing({note:text})).note, text);
});
check('a bare leading Note or Important that is real content is kept', () => {
  for (const text of ['Note 9 case is not included', 'Important documents folder included', 'Note-taking kit included', 'note pad and pen'])
    assert.equal(normalizeListing(listing({note:text})).note, text);
  assert.equal(normalizeListing(listing({note:'Please note: Note 9 case is not included'})).note, 'Note 9 case is not included');
});
check('titles already ending on a word boundary at 80 characters are not shortened further', () => {
  const {canonicalTitle} = require('../listing-core.js');
  const exact = 'Vintage film camera body with strap and case for collectors and fans ' + 'x'.repeat(80 - 69);
  assert.equal(exact.length, 80);
  assert.equal(canonicalTitle(exact + ' extra words'), exact);
  const mid = 'Vintage film camera body with strap and case for collectors and fans ' + 'abcdefghijklmnopqrstuvwxyz';
  assert.equal(canonicalTitle(mid), 'Vintage film camera body with strap and case for collectors and fans');
});
check('a shortened title never ends on a separator or a joining word', () => {
  const {canonicalTitle} = require('../listing-core.js');
  const lot = 'Film Photography Starter Lot: Canon AE-1 Program, FD 50mm f/1.8, Pentax K1000, Flash';
  assert.equal(canonicalTitle(lot), 'Film Photography Starter Lot: Canon AE-1 Program, FD 50mm f/1.8, Pentax K1000');
  const joined = 'Canon AE-1 Program 35mm SLR Film Camera Body Silver Tested Fresh Seals with Strap and Original Box';
  assert.ok(!/\s(and|with)$/i.test(canonicalTitle(joined)), canonicalTitle(joined));
  const dash = 'Canon AE-1 Program 35mm SLR Film Camera Body Silver Tested New Light Seals Fitted - Boxed Excellent';
  assert.ok(!/[-,]$/.test(canonicalTitle(dash)), canonicalTitle(dash));
  // Titles that already fit are never touched, even with a trailing comma.
  assert.equal(canonicalTitle('Short title,'), 'Short title,');
  // A hyphenated model at the end is kept.
  assert.equal(canonicalTitle('Vintage film camera body with strap and case for collectors and fans Canon AE-1 extra'), 'Vintage film camera body with strap and case for collectors and fans Canon AE-1');
});
check('the model title length is recorded and survives re-normalization', () => {
  const long = 'Vintage film camera body with strap and case for collectors and fans plus extra words';
  const first = normalizeListing(listing({title: long}));
  assert.equal(first.model_title_length, long.length);
  assert.ok(first.title.length <= 80);
  assert.equal(normalizeListing(first).model_title_length, long.length);
  assert.equal(normalizeListing(listing({title: 'Short'})).model_title_length, 5);
});
check('a note that is only a label yields an empty note', () => {
  for (const text of ['NOTE', 'please note:', '  Please note  '])
    assert.equal(normalizeListing(listing({note:text})).note, '');
});
check('mined keywords preserve model punctuation and short identifiers', () => {
  const result = titleKeywords([{title:'Sony WH-1000XM5 A7 EF-S 18-55mm f/2.8 for camera'}], new Set(['for']));
  for (const token of ['wh-1000xm5','a7','ef-s','18-55mm','f/2.8']) assert.ok(result.includes(token));
  assert.ok(!result.includes('for') && !result.includes('wh'));
});
check('keyword frequency counts titles rather than repetition within one title', () => {
  assert.deepEqual(titleKeywords([{title:'spam spam spam camera'}, {title:'camera lens'}], new Set(), 2), ['camera','spam']);
});
check('search sources retain only bounded eBay item links without tracking', () => {
  const normalize = require('../listing-core.js').normalizeSearchSources;
  assert.deepEqual(normalize([
    {title:'  Camera  ', url:'https://www.ebay.com/itm/123?tracking=value#details'},
    {title:'Duplicate', url:'https://www.ebay.com/itm/123'},
    {title:'Unsafe', url:'javascript:alert(1)'},
    {title:'Impostor', url:'https://www.ebay.com.evil.test/itm/1'},
    {title:'Credentials', url:'https://user:pass@www.ebay.com/itm/1'},
    {title:'HTTP', url:'http://www.ebay.com/itm/1'},
    {title:'Non-item', url:'https://www.ebay.com/signin'},
    {title:{bad:true}, url:'https://www.ebay.com/itm/456'},
  ]), [{title:'Camera', url:'https://www.ebay.com/itm/123'}]);
  assert.deepEqual(normalize(null), []);
  assert.equal(normalize(Array.from({length:30}, (_, i) => ({title:'x'.repeat(300),url:'https://www.ebay.com/itm/'+i}))).length, 20);
});
check('barcodes preserve leading zeros and reject non-barcode input', () => {
  const normalize = require('../listing-core.js').normalizeBarcode;
  assert.equal(normalize('0 12345-678905'), '012345678905');
  for (const value of ['12345678', '012345678905', '0012345678901', '00123456789012']) assert.equal(normalize(value), value);
  assert.equal(normalize('   '), '');
  for (const value of ['-', '123', '123456789', '１２３４５６７８', '01234567890x', 12345678, '0'.repeat(33)]) assert.throws(() => normalize(value));
});


check('source references require provenance and omit seller fields on restore', () => {
  const {normalizeSourcedReference, normalizeCandidates} = require('../listing-core.js');
  const source = {item_id:'v1|123|0', title:'Camera', url:'https://www.ebay.com/itm/123?track=x'};
  const ref = {kind:'ebay-listing', source, at:'2026-09-10T12:00:00Z', accepted:true,
    data:{product_name:'Untrusted seller title', summary:'Includes accessories', key_specs:{Model:'A1',Condition:'New',Shipping:'Free'}}};
  const normalized = normalizeSourcedReference(ref);
  assert.deepEqual(normalized.data, {product_name:'',key_specs:{Model:'A1'}});
  assert.equal(normalized.source.url, 'https://www.ebay.com/itm/123');
  assert.equal(normalized.accepted, true);
  for (const bad of [{...ref,kind:'ai'}, {...ref,at:''}, {...ref,source:{...source,url:'https://evil.test/itm/123'}}, {...ref,source:{...source,item_id:'../123'}}])
    assert.throws(() => normalizeSourcedReference(bad));
  assert.deepEqual(normalizeCandidates([{...source,item_id:'../123'}, {...source,url:'javascript:alert(1)'}]), []);
});

/* ---- bundle description parser, brands ---- */
check('bundle parser makes one item per line, never splitting commas, semicolons, plus or ampersand', () => {
  const {parseBundleItems} = require('../listing-core.js');
  assert.deepEqual(parseBundleItems('Mario Kart 8\nZelda BOTW\r\n\n'), ['Mario Kart 8', 'Zelda BOTW']);
  assert.deepEqual(parseBundleItems('Mario Kart 8, Zelda, Pikmin 4'), ['Mario Kart 8, Zelda, Pikmin 4']);
  assert.deepEqual(parseBundleItems('Switch + dock & charger; HDMI cable'), ['Switch + dock & charger; HDMI cable']);
  assert.deepEqual(parseBundleItems('1,000 piece puzzle\nController (black, wired)\nDock'), ['1,000 piece puzzle', 'Controller (black, wired)', 'Dock']);
  assert.deepEqual(parseBundleItems('- Canon AE-1, black\n- 50mm f/1.8 lens, with caps'), ['Canon AE-1, black', '50mm f/1.8 lens, with caps']);
});
check('a one-line bundle description with commas and sentences makes no items', () => {
  const {parseBundleItems} = require('../listing-core.js');
  assert.deepEqual(parseBundleItems('Lot of 5 Hot Wheels cars, 1990s, some paint chips. Pickup or ship.'), []);
  assert.deepEqual(parseBundleItems('Nikon FM2 body, chrome. Shutter fires at every speed.'), []);
  assert.deepEqual(parseBundleItems('all games tested. Mario Kart 8'), []);
});
check('bundle parser strips bullets and numbering', () => {
  const {parseBundleItems} = require('../listing-core.js');
  assert.deepEqual(parseBundleItems('- Switch console\n• Dock\n* Joy-Con\n1. Charger\n2) Case\n– Strap'), ['Switch console', 'Dock', 'Joy-Con', 'Charger', 'Case', 'Strap']);
  assert.deepEqual(parseBundleItems('Camera • Lens • Strap'), ['Camera', 'Lens', 'Strap']);
  assert.deepEqual(parseBundleItems('1.5m HDMI cable'), ['1.5m HDMI cable']);
});
check('bundle parser keeps quantities in the name as Nx', () => {
  const {parseBundleItems} = require('../listing-core.js');
  assert.deepEqual(parseBundleItems('2x Joy-Con\nController x2\n3 x Game cartridge\nPro Controller (x2)\n4X Cable\nStrap 2x'),
    ['2x Joy-Con', '2x Controller', '3x Game cartridge', '2x Pro Controller', '4x Cable', '2x Strap']);
  assert.deepEqual(parseBundleItems('Xbox 360\n3DS XL\n3x3 cube'), ['Xbox 360', '3DS XL', '3x3 cube']);
});
check('bundle parser trims filler words and headings', () => {
  const {parseBundleItems} = require('../listing-core.js');
  assert.deepEqual(parseBundleItems('Bundle of Mario Kart\nZelda'), ['Mario Kart', 'Zelda']);
  assert.deepEqual(parseBundleItems('Includes: dock and more'), ['dock']);
  assert.deepEqual(parseBundleItems('Lot of 5 cables'), ['5 cables']);
  assert.deepEqual(parseBundleItems('Comes with charger\nCase included\nplus strap\netc.'), ['charger', 'Case', 'strap']);
  assert.deepEqual(parseBundleItems('Games:\nMario\nZelda'), ['Mario', 'Zelda']);
  assert.deepEqual(parseBundleItems('Lot of 3 games: Halo 3'), ['Halo 3']);
  assert.deepEqual(parseBundleItems('The Legend of Zelda'), ['The Legend of Zelda']);
});
check('bundle parser skips note-like lines instead of guessing', () => {
  const {parseBundleItems} = require('../listing-core.js');
  assert.deepEqual(parseBundleItems('Everything works great, tested last week, missing the manual\nMario Kart'), ['Mario Kart']);
  assert.deepEqual(parseBundleItems('This is a lovely set of things kept in a cupboard for many years'), []);
  assert.deepEqual(parseBundleItems('No charger\nNot included: box\nUntested\nCondition: used'), []);
  assert.deepEqual(parseBundleItems('Retro games lot from my childhood'), []);
});
check('bundle parser keeps title-case names, abbreviations and ampersands on their line', () => {
  const {parseBundleItems} = require('../listing-core.js');
  assert.deepEqual(parseBundleItems("No Man's Sky\nDr. Mario\nMario & Luigi"), ["No Man's Sky", 'Dr. Mario', 'Mario & Luigi']);
  assert.deepEqual(parseBundleItems('Zelda BOTW & Pro controller'), ['Zelda BOTW & Pro controller']);
  assert.deepEqual(parseBundleItems('Untested Gameboy Advance'), ['Untested Gameboy Advance']);
  assert.deepEqual(parseBundleItems('Nintendo Switch OLED console with dock and original box'), ['Nintendo Switch OLED console with dock and original box']);
});
check('bundle parser handles unicode, duplicates and empty input', () => {
  const {parseBundleItems} = require('../listing-core.js');
  assert.deepEqual(parseBundleItems('Pokémon Schwert • Café-Tasse • 東京タワー模型'), ['Pokémon Schwert', 'Café-Tasse', '東京タワー模型']);
  assert.deepEqual(parseBundleItems('Pokémon Schwert'), [String.fromCharCode(80, 111, 107, 101, 769, 109, 111, 110) + ' Schwert'].map(v => v.normalize('NFC')));
  assert.deepEqual(parseBundleItems('Dock\ndock\nDOCK'), ['Dock']);
  for (const empty of ['', '   \n  ', null, undefined, 42, ['Dock'], '- \n• \n12, 34']) assert.deepEqual(parseBundleItems(empty), []);
  assert.equal(parseBundleItems(Array.from({length: 80}, (_, i) => 'Item ' + i).join('\n')).length, 50);
});
check('bundle parser never returns a condition', () => {
  const {parseBundleItems} = require('../listing-core.js');
  const names = parseBundleItems('Camera (used)\nLens - new\nFlash (for parts)');
  assert.ok(names.every(name => typeof name === 'string'));
  assert.deepEqual(names, ['Camera (used)', 'Lens - new', 'Flash (for parts)']);
});
check('brand detection only matches whole leading words of known brands', () => {
  const {detectBrand} = require('../listing-core.js');
  assert.equal(detectBrand('Nintendo Switch OLED', ['Nin', 'Nintendo', 'Nintendo Switch']), 'Nintendo Switch');
  assert.equal(detectBrand('nintendo switch', ['Nintendo']), 'Nintendo');
  assert.equal(detectBrand('Nintendogs cartridge', ['Nintendo']), '');
  assert.equal(detectBrand('Mario Kart 8', ['Nintendo']), '');
  assert.equal(detectBrand('Sony', ['Sony']), 'Sony');
  assert.equal(detectBrand('Sony-branded cable', ['Sony']), 'Sony');
  assert.equal(detectBrand('Anything', []), '');
});
check('bundle brand summary: unique brands, shared only when every named card agrees', () => {
  const {bundleBrandSummary} = require('../listing-core.js');
  assert.deepEqual(bundleBrandSummary([{name:'A',brand:'Sony'}, {name:'B',brand:' sony '}, {name:'',brand:'Ignored'}]), {brands:['Sony'], shared:'Sony', unbranded:0});
  assert.deepEqual(bundleBrandSummary([{name:'A',brand:'Sony'}, {name:'B',brand:'Nintendo'}]), {brands:['Sony','Nintendo'], shared:'', unbranded:0});
  assert.deepEqual(bundleBrandSummary([{name:'A',brand:'Sony'}, {name:'B'}]), {brands:['Sony'], shared:'', unbranded:1});
  assert.deepEqual(bundleBrandSummary([]), {brands:[], shared:'', unbranded:0});
});
check('seller brands pair like conditions and set or remove the Brand specific', () => {
  const {applySellerBrands} = require('../listing-core.js');
  const make = () => normalizeListing(listing({item_specifics:{Brand:'Invented', Model:'X'}, bundle_items:[{name:'Mario Kart 8', brand:'Model brand'}, {name:'DualSense'}]}));
  const one = applySellerBrands(make(), {brand:'Nintendo', items:[{name:'Mario Kart', brand:'Nintendo'}, {name:'Pad', brand:'Sony'}]});
  assert.deepEqual(one.item_specifics, {Brand:'Nintendo', Model:'X'});
  assert.deepEqual(one.bundle_items.map(b => b.brand), ['Nintendo', 'Sony']);
  const none = applySellerBrands(make(), {brand:'', items:[{name:'Only one', brand:'Sony'}]});
  assert.deepEqual(none.item_specifics, {Model:'X'});
  assert.deepEqual(none.bundle_items.map(b => b.brand), ['', '']);
  const renamed = normalizeListing(listing({bundle_items:[{name:'Camera'}, {name:'Strap'}]}));
  applySellerBrands(renamed, {brand:'', items:[{name:'camera', brand:'Canon'}]});
  assert.deepEqual(renamed.bundle_items.map(b => b.brand), ['Canon', '']);
  const full = normalizeListing(listing({item_specifics:Object.fromEntries(Array.from({length:30}, (_, i) => ['K' + i, 'v']))}));
  assert.equal(Object.keys(applySellerBrands(full, {brand:'Sony', items:[]}).item_specifics).length, 30);
});
check('bundle condition pairing still works with the added brand field', () => {
  const data = normalizeListing(listing({bundle_items:[{name:'Camera', brand:'Canon'}, {name:'Lens'}]}));
  assert.deepEqual(Object.keys(data.bundle_items[0]), ['name', 'condition', 'description', 'brand']);
  applySellerCondition(data, {condition:'', notes:'', items:[{name:'Camera', condition:'USED', brand:'Canon'}, {name:'Lens', condition:'FOR_PARTS', brand:''}]});
  assert.deepEqual(data.bundle_items.map(b => b.condition), ['Used', 'For parts or not working']);
  assert.equal(normalizeListing(data).bundle_items[0].brand, 'Canon');
  assert.throws(() => normalizeListing(listing({bundle_items:[{name:'A', brand:42}]})));
});

/* ---- v0.2.0: items stay with their cards, list splitting, contact details, seller header ---- */
check('linked bundle items keep their own card after cards are added, removed or reordered', () => {
  const {linkBundleCards, applySellerBrands} = require('../listing-core.js');
  const cards = [{id:'c1', name:'Camera body', condition:'USED', brand:'Canon'}, {id:'c2', name:'Battery grip', condition:'NEW', brand:'Meike'},
    {id:'c3', name:'Charger', condition:'FOR_PARTS', brand:''}];
  const data = linkBundleCards(normalizeListing(listing({bundle_items:[{name:'Canon body'}, {name:'BG-5D grip'}, {name:'OEM charger'}]})), cards);
  assert.deepEqual(data.bundle_items.map(b => b.card_id), ['c1', 'c2', 'c3']);
  applySellerCondition(data, {condition:'', notes:'', items:cards});
  applySellerBrands(data, {brand:'', items:cards});
  // A fourth card, a new order and an edited condition: only the edited card's item changes.
  const later = [{id:'c4', name:'Strap', condition:'NEW', brand:'Canon'}, cards[2], {...cards[1], condition:'GUC'}, cards[0]];
  applySellerCondition(data, {condition:'USED', notes:'Light wear', items:later});
  applySellerBrands(data, {brand:'', items:later});
  assert.deepEqual(data.bundle_items.map(b => b.condition), ['Used', 'Good Used Condition (GUC)', 'For parts or not working']);
  assert.deepEqual(data.bundle_items.map(b => b.brand), ['Canon', 'Meike', '']);
  // The camera body's card is removed: its item keeps what it had.
  applySellerCondition(data, {condition:'USED', notes:'', items:[cards[1], cards[2]]});
  applySellerBrands(data, {brand:'', items:[cards[1], cards[2]]});
  assert.deepEqual(data.bundle_items.map(b => b.condition), ['Used', 'New', 'For parts or not working']);
  assert.deepEqual(data.bundle_items.map(b => b.brand), ['Canon', 'Meike', '']);
});
check('an item left unpaired at generation stays unspecified when cards change later', () => {
  const {linkBundleCards} = require('../listing-core.js');
  const data = linkBundleCards(normalizeListing(listing({bundle_items:[{name:'Camera'}, {name:'Invented extra'}]})), [{id:'c1', name:'camera', condition:'USED'}]);
  assert.deepEqual(data.bundle_items.map(b => b.card_id), ['c1', '']);
  applySellerCondition(data, {condition:'', notes:'', items:[{id:'c1', name:'Camera', condition:'USED'}, {id:'c2', name:'Lens', condition:'NEW'}]});
  assert.deepEqual(data.bundle_items.map(b => b.condition), ['Used', 'Condition not specified']);
});
check('card ids survive normalization, model output gains none, and linking ignores ids the model wrote', () => {
  const {linkBundleCards} = require('../listing-core.js');
  const linked = normalizeListing(listing({bundle_items:[{name:'A', card_id:'c9'}]}));
  assert.equal(linked.bundle_items[0].card_id, 'c9');
  assert.ok(!('card_id' in normalizeListing(listing({bundle_items:[{name:'A'}]})).bundle_items[0]));
  assert.throws(() => normalizeListing(listing({bundle_items:[{name:'A', card_id:7}]})));
  assert.deepEqual(linkBundleCards(linked, [{id:'c1', name:'A'}]).bundle_items.map(b => b.card_id), ['c1']);
});
check('included items split on commas, semicolons and lines, but not inside brackets or numbers', () => {
  const {splitListItems} = require('../listing-core.js');
  assert.deepEqual(splitListItems('Charger, lens cap; strap\nManual'), ['Charger', 'lens cap', 'strap', 'Manual']);
  assert.deepEqual(splitListItems(' 1,000 piece puzzle , Cable (USB-C, 1m) ;; '), ['1,000 piece puzzle', 'Cable (USB-C, 1m)']);
  assert.deepEqual(splitListItems('Box (open\nStrap'), ['Box (open', 'Strap']);
  for (const empty of ['', ' , ; ', null, undefined]) assert.deepEqual(splitListItems(empty), []);
});
check('contact details are found in listing text: web addresses and emails', () => {
  const {findContactDetail} = require('../listing-core.js');
  for (const [text, found] of [['Visit www.example.com for more.', 'www.example.com'], ['See https://shop.example.net/item?id=1, thanks', 'https://shop.example.net/item?id=1'],
    ['Write to me@example.com.', 'me@example.com'], ['Also at example.co.uk today', 'example.co.uk'], ['Find us on EXAMPLE.COM/store', 'EXAMPLE.COM/store'],
    ['Camera body. Instagram: http://instagram.com/shop', 'http://instagram.com/shop']]) assert.equal(findContactDetail(text), found, text);
  for (const text of ['Canon AE-1 Program, f/1.8 lens, 3.5mm jack', 'e.g. No. 5 of 10, v1.2.3, Dr. Mario', '99.6% positive, U.S.A. model',
    'Firmware 2.0. Works', 'Node 9.0 board', 'Model: XC-1.5', '', null]) assert.equal(findContactDetail(text), '', String(text));
});
check('seller header: member year wording and validation', () => {
  const {memberSinceText} = require('../listing-core.js');
  assert.equal(memberSinceText('2026', 2026), 'Member since 2026');
  assert.equal(memberSinceText(' 2025 ', 2026), 'Member for 1 year');
  assert.equal(memberSinceText('2014', 2026), 'Member for 12 years');
  assert.equal(memberSinceText('1995', 2026), 'Member for 31 years');
  for (const bad of ['15', '1994', '2027', '20 14', 'abcd', '', null]) assert.equal(memberSinceText(bad, 2026), '', String(bad));
});
check('seller header: positive percentage strips a typed % and stays within 0 to 100', () => {
  const {positivePercent} = require('../listing-core.js');
  for (const [value, expected] of [['99.6%', '99.6'], [' 99.6 % ', '99.6'], ['100', '100'], ['0', '0'], ['98', '98']]) assert.equal(positivePercent(value), expected, value);
  for (const bad of ['101', '100.5', '-1', 'abc', '99.6%%', '%', '', null]) assert.equal(positivePercent(bad), '', String(bad));
});
check('messages: every error kind has plain words, and the fixable ones name their fix', () => {
  const {ERROR_MESSAGES, hasJargon, errorFix} = require('../listing-core.js');
  const kinds = ['no_provider', 'provider_busy', 'provider_auth', 'provider_timeout', 'provider_request', 'provider_storage', 'local_busy',
    'notes_too_long', 'ebay_not_configured', 'ebay_auth', 'ebay_unavailable', 'ebay_listing_gone', 'invalid_barcode', 'ebay_busy',
    'ebay_storage', 'ebay_no_details', 'ebay_not_connected', 'ebay_connect_failed', 'ebay_storage_write', 'provider_storage_write',
    'invalid_request', 'not_found', 'forbidden', 'session_expired', 'server_error', 'unknown_key', 'invalid_key', 'invalid_url', 'nothing_to_save'];
  for (const kind of kinds) assert.ok(ERROR_MESSAGES[kind], kind);
  for (const [kind, entry] of Object.entries(ERROR_MESSAGES)) {
    for (const text of [entry.text, entry.note].filter(Boolean)) {
      assert.ok(!hasJargon(text) && /^(?:[A-Z]|eBay)/.test(text) && /[.)]$/.test(text) && text.length <= 200, kind + ': ' + text);
      assert.ok(!/\.\.\.|->|→/.test(text), 'menu paths use ›: ' + text);
    }
  }
  assert.deepEqual(['no_provider', 'provider_auth', 'provider_storage'].map(errorFix), ['ai', 'ai', 'ai']);
  assert.deepEqual(['ebay_not_configured', 'ebay_auth', 'ebay_not_connected'].map(errorFix), ['ebay', 'ebay', 'ebay']);
  assert.deepEqual(['provider_busy', 'ebay_unavailable', 'nonsense', '', undefined].map(errorFix), ['', '', '', '', '']);
  assert.equal(ERROR_MESSAGES.no_provider.text, 'Connect an AI service first. It takes about 2 minutes with a free Google key.');
  assert.equal(ERROR_MESSAGES.ebay_not_configured.text, 'Look up needs an eBay key (optional). Add one in Settings › eBay, or just describe the item.');
});
check('messages: the server\'s plain text is preferred, technical text is replaced', () => {
  const {plainError, isPlainMessage, errorNote} = require('../listing-core.js');
  const busy = 'The AI services are busy right now. Your draft is safe. Try again in 30 seconds.';
  assert.equal(plainError('provider_busy', busy), busy);
  assert.equal(plainError('ebay_auth', ' eBay didn\'t accept your eBay keys.\n Check them. '), 'eBay didn\'t accept your eBay keys. Check them.');
  for (const technical of ['EBAY_CLIENT_ID not set', 'Lookup failed. EBAY_CLIENT_ID not set.', 'eBay search returned HTTP 503. Please retry.',
    'Invalid max_tokens', 'Every configured AI provider is busy.', 'Request body must be a JSON object', 'not found', 'Failed to fetch',
    'Check the AI status and your provider keys in Settings.', 'OAuth exchange failed: token missing.', '', null, 42]) {
    assert.ok(!isPlainMessage(technical), String(technical));
  }
  assert.equal(plainError('ebay_not_configured', 'EBAY_CLIENT_ID not set'),
    'Look up needs an eBay key (optional). Add one in Settings › eBay, or just describe the item.');
  assert.equal(plainError('', 'eBay search returned HTTP 503. Please retry.', 'ebay_unavailable'),
    'eBay couldn\'t be reached. Try again in a minute, or just describe the item.');
  assert.equal(plainError('mystery', undefined), 'Marteloio couldn\'t finish this. Try again in a minute.');
  assert.equal(errorNote('no_provider', 'anything'), 'Couldn\'t write the listing: no AI service is connected yet.');
  assert.equal(errorNote('ebay_listing_gone', 'This listing is no longer on eBay. Pick another one.', 'Look up didn\'t work'),
    'Look up didn\'t work. This listing is no longer on eBay. Pick another one.');
});
check('AI keys: pasted keys are recognised by their start, without quotes or Bearer', () => {
  const {recognizeKey, cleanPastedKey} = require('../listing-core.js');
  const cases = [[' AIzaSyFixtureGeminiKey0123456789abcd ', 'gemini', 'Google Gemini', 'key'], ['"Bearer gsk_fixtureGroqKey0123"', 'groq', 'Groq', 'key'],
    ['bearer sk-or-v1-0123456789abcdef\n', 'openrouter', 'OpenRouter', 'key'], ['“freellmapi-0a1b2c3d0a1b2c3d”', 'freellmapi', 'FreeLLMAPI', 'key'],
    ['sk-cp-fixtureProfileKey0123', 'freellmapi', 'FreeLLMAPI', 'key'],
    ['http://127.0.0.1:31415/v1/t/flmurl_fixtureToken0123', 'freellmapi', 'FreeLLMAPI', 'address']];
  for (const [text, id, label, kind] of cases) assert.deepEqual(recognizeKey(text), {id, label, kind}, text);
  for (const text of ['hello', 'sk-proj-openai-style-key', 'http://127.0.0.1:31415/v1', 'aiza-lowercase', '', null]) assert.equal(recognizeKey(text), null, String(text));
  assert.equal(cleanPastedKey(" 'Bearer  AIzaX' "), 'AIzaX');
  assert.equal(cleanPastedKey('Bearer "gsk_x"'), 'gsk_x');
});
check('messages: how long each kind stays, from one table', () => {
  const {toastLife, TOAST_TIMES} = require('../listing-core.js');
  assert.deepEqual([TOAST_TIMES.busyDelay, TOAST_TIMES.busyElapsed, TOAST_TIMES.ok, TOAST_TIMES.okAction, TOAST_TIMES.note, TOAST_TIMES.err, TOAST_TIMES.errMax],
    [400, 10000, 4000, 10000, 8000, 10000, 20000]);
  assert.equal(toastLife('ok', 'Listing ready.', false), 4000);
  assert.equal(toastLife('ok', 'Saved your edited version in Recent drafts.', true), 10000);
  assert.equal(toastLife('note', 'x'.repeat(500), true), 8000);
  assert.equal(toastLife('err', 'Short problem.', false), 10000);
  const long = toastLife('err', 'x'.repeat(220), false);
  assert.ok(long > 10000 && long < 20000, String(long));
  assert.equal(toastLife('err', 'x'.repeat(5000), false), 20000);
  assert.equal(toastLife('busy', 'Writing your listing…', false), 0);
  assert.equal(toastLife('ok', 'x', false, {...TOAST_TIMES, ok: 50}), 50);
});
check('first run: the guide record keeps only known values', () => {
  const {normalizeGuide, GUIDE_DEFAULTS} = require('../listing-core.js');
  const blank = {welcome: '', tour: '', generated: false, copied: false, checklist: 'auto', startHereDismissed: false, tipsShown: [], tourNotice: false};
  for (const value of [null, undefined, 'done', 42, [], {welcome: 'yes', tour: 1, generated: 'true', checklist: 'gone', tipsShown: 'copyHtml'}]) {
    assert.deepEqual(normalizeGuide(value), blank, JSON.stringify(value));
  }
  assert.deepEqual({...GUIDE_DEFAULTS, tipsShown: []}, blank);
  const full = {welcome: 'skipped', tour: 'done', generated: true, copied: true, checklist: 'shown', startHereDismissed: true,
    tipsShown: ['copyHtml', 'copyHtml', '<script>', 7, 'x'.repeat(31)], tourNotice: true, extra: 'dropped'};
  assert.deepEqual(normalizeGuide(full), {welcome: 'skipped', tour: 'done', generated: true, copied: true, checklist: 'shown',
    startHereDismissed: true, tipsShown: ['copyHtml'], tourNotice: true});
});
check('first run: the first AI status decides welcome, tour notice and checklist', () => {
  const {firstRunPlan, aiConnected} = require('../listing-core.js');
  const none = {ready: false, retry_in: 0, providers: [{id: 'gemini', configured: false, state: 'off'}, {id: 'groq', configured: false, state: 'off'}]};
  const resting = {ready: false, retry_in: 40, providers: [{id: 'gemini', configured: true, state: 'rate_limited'}]};
  const unreadable = {ready: false, retry_in: 0, providers: [], error: 'Marteloio couldn\'t read your saved keys.', kind: 'provider_storage'};
  assert.deepEqual([none, resting, unreadable, null, {}].map(aiConnected), [false, true, false, false, false]);
  assert.deepEqual(firstRunPlan({}, none, false), {welcome: true, notice: false, patch: {}});
  assert.deepEqual(firstRunPlan({}, unreadable, true), {welcome: true, notice: false, patch: {}});
  for (const welcome of ['done', 'skipped']) assert.deepEqual(firstRunPlan({welcome}, none, false), {welcome: false, notice: false, patch: {}});
  assert.deepEqual(firstRunPlan({}, resting, false), {welcome: false, notice: true, patch: {welcome: 'skipped', tourNotice: true}});
  assert.deepEqual(firstRunPlan({}, resting, true), {welcome: false, notice: true, patch: {welcome: 'skipped', tourNotice: true, checklist: 'hidden'}});
  assert.deepEqual(firstRunPlan({tour: 'skipped'}, resting, true), {welcome: false, notice: false, patch: {welcome: 'skipped', checklist: 'hidden'}});
  assert.deepEqual(firstRunPlan({tourNotice: true, checklist: 'shown'}, resting, true), {welcome: false, notice: false, patch: {welcome: 'skipped'}});
});
check('first run: which form of the Get set up guide shows, and its steps', () => {
  const {guideMode, setupSteps} = require('../listing-core.js');
  assert.deepEqual([[{}, false], [{}, true], [{copied: true}, false], [{checklist: 'hidden'}, false], [{checklist: 'shown', copied: true}, true]]
    .map(([guide, listing]) => guideMode(guide, listing, false)), ['full', 'strip', 'none', 'none', 'full']);
  assert.equal(guideMode({checklist: 'shown'}, false, true), 'none');
  assert.deepEqual(setupSteps({}), {done: [false, false, false, false], now: 0});
  assert.deepEqual(setupSteps({connected: true, described: true}), {done: [true, true, false, false], now: 2});
  assert.deepEqual(setupSteps({connected: false, generated: true}), {done: [false, true, true, false], now: 0});
  assert.deepEqual(setupSteps({connected: true, copied: true}), {done: [true, true, true, true], now: -1});
});
check('first run: the header AI button says Set up AI, AI ready or AI busy with the time', () => {
  const {aiPill} = require('../listing-core.js');
  const p = (configured, state, extra) => ({id: 'gemini', label: 'Google Gemini', configured, state, ...extra});
  assert.deepEqual(aiPill({ready: true, retry_in: 0, providers: [p(true, 'ready')]}), {tone: 'ready', text: 'AI ready', setup: false});
  assert.deepEqual(aiPill({ready: false, retry_in: 0, providers: [p(false, 'off')]}), {tone: 'setup', text: 'Set up AI', setup: true});
  assert.deepEqual(aiPill({ready: false, retry_in: 0, providers: [], kind: 'provider_storage', error: 'x'}), {tone: 'setup', text: 'Set up AI', setup: true});
  assert.deepEqual(aiPill({ready: false, retry_in: 40, providers: [p(true, 'rate_limited', {retry_in: 40})]}), {tone: 'busy', text: 'AI busy · 40 s', setup: false});
  assert.deepEqual(aiPill({ready: false, retry_in: 0, providers: [p(true, 'unavailable')]}), {tone: 'off', text: 'AI offline', setup: false});
  assert.deepEqual(aiPill(null), {tone: 'off', text: 'AI offline', setup: false});
});
check('first run: a tip, tooltip or tour card is never cut off (flip and shift)', () => {
  const {placeFloating} = require('../listing-core.js');
  const view = {width: 1366, height: 768}, size = {width: 300, height: 120};
  const rect = (left, top, width, height) => ({left, top, right: left + width, bottom: top + height});
  assert.deepEqual(placeFloating(rect(600, 100, 40, 20), size, view), {side: 'below', left: 470, top: 130, arrow: 150});
  // Too close to the bottom: it flips above.
  const flipped = placeFloating(rect(600, 700, 40, 20), size, view);
  assert.equal(flipped.side, 'above'); assert.equal(flipped.top, 700 - 10 - 120);
  // Near the left edge: it shifts inside, and the arrow still points at the anchor.
  const shifted = placeFloating(rect(4, 100, 20, 20), size, view);
  assert.equal(shifted.left, 8); assert.equal(shifted.arrow, 16);
  const right = placeFloating(rect(1340, 100, 20, 20), size, view);
  assert.equal(right.left, 1366 - 8 - 300); assert.equal(right.arrow, 300 - 16);
  // A phone: full width boxes stay inside, and a tall anchor puts the box beside or over it.
  const phone = placeFloating(rect(20, 300, 30, 20), {width: 366, height: 140}, {width: 390, height: 844}, {margin: 12});
  assert.ok(phone.left === 12 && phone.top >= 12 && phone.top + 140 <= 844 - 12, JSON.stringify(phone));
  const beside = placeFloating(rect(800, 40, 500, 700), {width: 360, height: 180}, view, {order: ['below', 'above', 'left', 'right']});
  assert.equal(beside.side, 'left'); assert.ok(beside.left + 360 <= 800 - 10 && beside.top >= 8 && beside.top + 180 <= 760);
  // No side has room: the roomiest side, still inside the viewport.
  const cramped = placeFloating(rect(0, 0, 390, 844), {width: 366, height: 200}, {width: 390, height: 844}, {margin: 12});
  assert.ok(cramped.left >= 12 && cramped.top >= 12 && cramped.top + 200 <= 832, JSON.stringify(cramped));
  // align start: the arrow sits near the box's start, pointing at the anchor.
  const start = placeFloating(rect(180, 400, 18, 18), size, view, {align: 'start'});
  assert.ok(start.left < 180 && start.arrow === 189 - start.left && start.arrow <= 30, JSON.stringify(start));
});
check('first run: the approved tip and tour texts, in plain words', () => {
  const {GUIDE_TIPS, TOUR_STOPS, hasJargon} = require('../listing-core.js');
  assert.deepEqual(Object.keys(GUIDE_TIPS), ['startHere', 'product', 'lookup', 'keywords', 'describe', 'included', 'condition', 'conditionNotes', 'brand',
    'bundle', 'newListing', 'generate', 'copyHtml', 'regenerate', 'editContent', 'shuffle', 'drafts', 'aiStatus']);
  assert.equal(GUIDE_TIPS.lookup.text, 'Optional. Finds other sellers\' eBay listings for this product so you can borrow their specs. Needs a free eBay developer key (Settings › eBay). You can skip it.');
  assert.equal(GUIDE_TIPS.copyHtml.text, 'In eBay\'s listing form, switch the description box to HTML (the < > button), paste, then check the preview.');
  assert.equal(GUIDE_TIPS.generate.text, 'Writes the title and description from your notes, usually in 10–30 seconds.');
  assert.deepEqual(TOUR_STOPS.map(stop => stop.title), ['Start here', 'Describe the item', 'Condition', 'Generate listing', 'Review', 'Copy into eBay']);
  for (const entry of [...Object.values(GUIDE_TIPS), ...TOUR_STOPS]) {
    // "HTML" and "eBay" are what the seller sees on screen; "developer key" names eBay's own page.
    assert.ok(!hasJargon(entry.text.replace(/HTML/g, '')) && /^[A-Z]/.test(entry.text) && /[.)]$/.test(entry.text) && entry.text.length <= 200, entry.text);
  }
});
/* ---- v0.2.0 QA walkthrough fixes ---- */
const service = extra => ({id: 'gemini', label: 'Google Gemini', configured: true, enabled: true, state: 'ready', retry_in: 0, key_hint: 'a1B2',
  checked: '', model: 'gemini-flash-latest', ...extra});
check('QA: connected means set up, switched on, not turned down and its last check not failed', () => {
  const {serviceConnected, aiConnected, firstRunPlan} = require('../listing-core.js');
  assert.deepEqual([service(), service({checked: 'ok'}), service({state: 'rate_limited', retry_in: 30}), service({checked: 'failed'}),
    service({state: 'key_rejected'}), service({enabled: false, state: 'disabled'}), service({configured: false, state: 'off'}), null].map(serviceConnected),
    [true, true, true, false, false, false, false, false]);
  assert.equal(aiConnected({ready: true, retry_in: 0, providers: [service({checked: 'failed'})]}), false);
  assert.equal(aiConnected({ready: true, retry_in: 0, providers: [service({checked: 'failed'}), service({id: 'freellmapi', checked: 'ok'})]}), true);
  // A key that failed its check doesn't count as set up: the welcome still opens.
  assert.deepEqual(firstRunPlan({}, {ready: true, retry_in: 0, providers: [service({checked: 'failed'})]}, false), {welcome: true, notice: false, patch: {}});
});
check('QA: the AI button says AI ready only for a connected service, AI busy for a rate limit, AI offline with the time otherwise', () => {
  const {aiPill} = require('../listing-core.js');
  const setup = {tone: 'setup', text: 'Set up AI', setup: true};
  assert.deepEqual(aiPill({ready: true, retry_in: 0, providers: [service({checked: 'failed'})]}), setup);
  assert.deepEqual(aiPill({ready: false, retry_in: 0, providers: [service({enabled: false, state: 'disabled'})]}), setup);
  assert.deepEqual(aiPill({ready: false, retry_in: 30, providers: [service({state: 'unavailable', retry_in: 30})]}), {tone: 'off', text: 'AI offline · 30 s', setup: false});
  assert.deepEqual(aiPill({ready: false, retry_in: 12, providers: [service({state: 'timeout', retry_in: 12})]}), {tone: 'off', text: 'AI offline · 12 s', setup: false});
  assert.deepEqual(aiPill({ready: false, retry_in: 30, providers: [service({state: 'rate_limited', retry_in: 30})]}), {tone: 'busy', text: 'AI busy · 30 s', setup: false});
  // The service back soonest decides the words; a failing one that is "ready" doesn't make it AI ready.
  assert.deepEqual(aiPill({ready: false, retry_in: 20, providers: [service({state: 'unavailable', retry_in: 45}), service({id: 'groq', state: 'rate_limited', retry_in: 20})]}),
    {tone: 'busy', text: 'AI busy · 20 s', setup: false});
  assert.deepEqual(aiPill({ready: true, retry_in: 0, providers: [service({checked: 'failed'}), service({id: 'freellmapi', state: 'unavailable', retry_in: 40, checked: 'ok'})]}),
    {tone: 'off', text: 'AI offline · 40 s', setup: false});
});
check('QA: each AI service in plain words, as its Settings chip says it, never its model', () => {
  const {aiServiceState} = require('../listing-core.js');
  assert.deepEqual([service(), service({checked: 'failed'}), service({state: 'key_rejected', checked: 'failed'}), service({enabled: false, state: 'disabled'}),
    service({configured: false, state: 'off'}), service({state: 'rate_limited', retry_in: 40}), service({state: 'unavailable', retry_in: 30, checked: 'failed'})]
    .map(entry => aiServiceState(entry).text), ['Ready', 'Test failed', 'Key rejected', 'Off', 'Not set up', 'Resting 40 s', 'Resting 30 s']);
});
check('QA: messages for FreeLLMAPI not running, FreeLLMAPI without services, and every service switched off', () => {
  const {ERROR_MESSAGES, errorFix, plainError, hasJargon} = require('../listing-core.js');
  assert.equal(ERROR_MESSAGES.freellmapi_not_running.text, 'FreeLLMAPI isn\'t running on this computer. Start it, then try again.');
  assert.equal(ERROR_MESSAGES.freellmapi_no_services.text, 'FreeLLMAPI is running but has no AI services yet. Add a key on its Keys page, then try again.');
  assert.equal(ERROR_MESSAGES.all_disabled.text, 'Every AI service is switched off. Turn one on in Settings › AI.');
  assert.deepEqual(['all_disabled', 'freellmapi_not_running', 'freellmapi_no_services'].map(errorFix), ['aiSettings', '', '']);
  assert.equal(plainError('all_disabled', 'ALL_DISABLED'), ERROR_MESSAGES.all_disabled.text);
  for (const kind of ['all_disabled', 'freellmapi_not_running', 'freellmapi_no_services']) assert.ok(!hasJargon(ERROR_MESSAGES[kind].text), kind);
});
check('QA: a step note says what its message said, without "Your draft is safe." or a countdown', () => {
  const {errorNote} = require('../listing-core.js');
  const what = 'Couldn\'t write the listing';
  assert.equal(errorNote('provider_busy', 'The AI services couldn\'t be reached. Your draft is safe. Check your internet connection and try again in 30 seconds.', what),
    'Couldn\'t write the listing. The AI services couldn\'t be reached. Check your internet connection and try again in a moment.');
  assert.equal(errorNote('provider_busy', 'The AI services are busy right now. Your draft is safe. Try again in 1 second.', what),
    'Couldn\'t write the listing. The AI services are busy right now. Try again in a moment.');
  assert.equal(errorNote('freellmapi_no_services', 'FreeLLMAPI is running but has no AI services yet. Add a key on its Keys page, then try again.', what),
    'Couldn\'t write the listing. FreeLLMAPI is running but has no AI services yet. Add a key on its Keys page, then try again.');
  // A kind's own text keeps its short note.
  assert.equal(errorNote('provider_auth', 'Your AI key was turned down. Open Settings › AI and paste a new key.', what), 'Couldn\'t write the listing: your AI key was turned down.');
});

console.log(passed + ' validation checks passed');
