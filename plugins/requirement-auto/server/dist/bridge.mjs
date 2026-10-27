import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirnameOf } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirnameOf(__filename);
import{d as t,e as s}from"./shared-W7U42YIY.mjs";async function o(){let e=[];for await(let i of process.stdin)e.push(i);return Buffer.concat(e).toString("utf8")}var n=process.argv[2]??"",r;try{let e=t.has(n)?(await o()).trim():"";r=await s(n,e?JSON.parse(e):void 0)}catch{r={ok:!1,error:{kind:"invalid_request",message:"\u6807\u51C6\u8F93\u5165\u4E0D\u662F\u6709\u6548\u7684 JSON"}}}process.stdout.write(`${JSON.stringify(r)}
`);process.exitCode=r.ok?0:2;
