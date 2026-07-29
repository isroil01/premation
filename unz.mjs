import { unzipSync, strFromU8 } from 'fflate';
import fs from 'fs';
const un = unzipSync(new Uint8Array(fs.readFileSync('C:/Users/isroi/Downloads/Book a call.lottie')));
const inZip = strFromU8(un['a/Main Scene.json']);
const plain = fs.readFileSync('C:/Users/isroi/Downloads/Book a call.json','utf8');
console.log('identical:', inZip === plain, 'len', inZip.length, plain.length);
const a = JSON.parse(inZip), b = JSON.parse(plain);
console.log('zip  layers', a.layers.map(l=>`${l.ty}:${l.nm}`).join(' | '));
console.log('json layers', b.layers.map(l=>`${l.ty}:${l.nm}`).join(' | '));
console.log('zip assets', a.assets.map(x=>`${x.id}(${x.layers?x.l