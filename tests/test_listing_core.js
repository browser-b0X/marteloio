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
check('bundle parser splits lines, commas, semicolons, plus and ampersand', () => {
  const {parseBundleItems} = require('../listing-core.js');
  assert.deepEqual(parseBundleItems('Mario Kart 8\nZelda BOTW\r\n\n'), ['Mario Kart 8', 'Zelda BOTW']);
  assert.deepEqual(parseBundleItems('Mario Kart 8, Zelda, Pikmin 4'), ['Mario Kart 8', 'Zelda', 'Pikmin 4']);
  assert.deepEqual(parseBundleItems('Switch + dock & charger; HDMI cable'), ['Switch', 'dock', 'charger', 'HDMI cable']);
  assert.deepEqual(parseBundleItems('1,000 piece puzzle, Controller (black, wired), Dock'), ['1,000 piece puzzle', 'Controller (black, wired)', 'Dock']);
});
check('bundle parser strips bullets and numbering', () => {
  const {parseBundleItems} = require('../listing-core.js');
  assert.deepEqual(parseBundleItems('- Switch console\n• Dock\n* Joy-Con\n1. Charger\n2) Case\n– Strap'), ['Switch console', 'Dock', 'Joy-Con', 'Charger', 'Case', 'Strap']);
  assert.deepEqual(parseBundleItems('Camera • Lens • Strap'), ['Camera', 'Lens', 'Strap']);
  assert.deepEqual(parseBundleItems('1.5m HDMI cable'), ['1.5m HDMI cable']);
});
check('bundle parser keeps quantities in the name as Nx', () => {
  const {parseBundleItems} = require('../listing-core.js');
  assert.deepEqual(parseBundleItems('2x Joy-Con, Controller x2, 3 x Game cartridge, Pro Controller (x2), 4X Cable, Strap 2x'),
    ['2x Joy-Con', '2x Controller', '3x Game cartridge', '2x Pro Controller', '4x Cable', '2x Strap']);
  assert.deepEqual(parseBundleItems('Xbox 360, 3DS XL, 3x3 cube'), ['Xbox 360', '3DS XL', '3x3 cube']);
});
check('bundle parser trims filler words and headings', () => {
  const {parseBundleItems} = require('../listing-core.js');
  assert.deepEqual(parseBundleItems('Bundle of Mario Kart, Zelda'), ['Mario Kart', 'Zelda']);
  assert.deepEqual(parseBundleItems('Includes: dock, charger and more'), ['dock', 'charger']);
  assert.deepEqual(parseBundleItems('Lot of 5 cables'), ['5 cables']);
  assert.deepEqual(parseBundleItems('Comes with charger, Case included, plus strap, etc.'), ['charger', 'Case', 'strap']);
  assert.deepEqual(parseBundleItems('Games:\nMario\nZelda'), ['Mario', 'Zelda']);
  assert.deepEqual(parseBundleItems('The Legend of Zelda'), ['The Legend of Zelda']);
});
check('bundle parser skips note-like fragments instead of guessing', () => {
  const {parseBundleItems} = require('../listing-core.js');
  assert.deepEqual(parseBundleItems('Everything works great, tested last week, missing the manual, Mario Kart'), ['Mario Kart']);
  assert.deepEqual(parseBundleItems('This is a lovely set of things kept in a cupboard for many years'), []);
  assert.deepEqual(parseBundleItems('Nikon FM2 body, chrome. Shutter fires at every speed.'), ['Nikon FM2 body']);
  assert.deepEqual(parseBundleItems('No charger, Not included: box, Untested, Condition: used'), []);
  assert.deepEqual(parseBundleItems('Retro games lot from my childhood'), []);
});
check('bundle parser keeps title-case names and splits sentences and headings', () => {
  const {parseBundleItems} = require('../listing-core.js');
  assert.deepEqual(parseBundleItems("No Man's Sky, Dr. Mario, Mario & Luigi"), ["No Man's Sky", 'Dr. Mario', 'Mario & Luigi']);
  assert.deepEqual(parseBundleItems('all games tested. Mario Kart 8'), ['Mario Kart 8']);
  assert.deepEqual(parseBundleItems('Zelda BOTW & Pro controller'), ['Zelda BOTW', 'Pro controller']);
  assert.deepEqual(parseBundleItems('Lot of 3 games: Halo 3, Gears of War, Forza'), ['Halo 3', 'Gears of War', 'Forza']);
  assert.deepEqual(parseBundleItems('Untested Gameboy Advance, Untested'), ['Untested Gameboy Advance']);
  assert.deepEqual(parseBundleItems('Nintendo Switch OLED console with dock and original box'), ['Nintendo Switch OLED console with dock and original box']);
});
check('bundle parser handles unicode, duplicates and empty input', () => {
  const {parseBundleItems} = require('../listing-core.js');
  assert.deepEqual(parseBundleItems('Pokémon Schwert • Café-Tasse • 東京タワー模型'), ['Pokémon Schwert', 'Café-Tasse', '東京タワー模型']);
  assert.deepEqual(parseBundleItems('Pokémon Schwert'), [String.fromCharCode(80, 111, 107, 101, 769, 109, 111, 110) + ' Schwert'].map(v => v.normalize('NFC')));
  assert.deepEqual(parseBundleItems('Dock, dock, DOCK'), ['Dock']);
  for (const empty of ['', '   \n  ', null, undefined, 42, ['Dock'], '- \n• \n12, 34']) assert.deepEqual(parseBundleItems(empty), []);
  assert.equal(parseBundleItems(Array.from({length: 80}, (_, i) => 'Item ' + i).join(', ')).length, 50);
});
check('bundle parser never returns a condition', () => {
  const {parseBundleItems} = require('../listing-core.js');
  const names = parseBundleItems('Camera (used), Lens - new, Flash: for parts');
  assert.ok(names.every(name => typeof name === 'string'));
  assert.deepEqual(names, ['Camera (used)', 'Lens - new', 'Flash: for parts']);
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

console.log(passed + ' validation checks passed');
