// Assembles public/pie-logo.svg from the traced paths and the sampled gradients.
import fs from 'node:fs';

const P = JSON.parse(fs.readFileSync('__paths.json', 'utf8'));
const PILLS = JSON.parse(fs.readFileSync('__pills.json', 'utf8'));
const S = 100 / 1254;
const u = v => +(v * S).toFixed(2);

/* Gradient axes are in the same 100-unit space as the paths (userSpaceOnUse),
   each one aligned with the direction the reference actually shades in. */
const grads = [
  ['gA', u(345), 0, u(889), 0, [                       // upper arc: teal -> cyan
    [0, '#022F31'], [.21, '#028588'], [.5, '#00D3C6'], [.68, '#01DDCF'], [1, '#04C4D3']]],
  ['gB', u(462), u(940), u(950), u(620), [             // lower arc: navy -> blue -> navy
    [0, '#051F5B'], [.16, '#0A41B5'], [.3, '#0D46CD'], [.5, '#1F40E5'], [.72, '#1C41E4'],
    [.86, '#1146D0'], [1, '#032DA1']]],
  ['gL', u(560), u(525), u(500), u(892), [             // left leg: shaded top -> cyan
    [0, '#002D36'], [.15, '#016673'], [.3, '#018A9C'], [.5, '#0496AE'], [.75, '#047E9C'],
    [1, '#026E83']]],
  ['gP', u(430), u(420), u(840), u(870), [             // bar + right leg: teal -> deep blue
    [0, '#00DCC2'], [.27, '#09B2C9'], [.45, '#1580E0'], [.58, '#1F62E4'], [.72, '#1046C0'],
    [1, '#0A1A60']]],
  ['gF', u(425), u(592), u(515), u(545), [             // ribbon underside
    [0, '#08484A'], [.45, '#00302F'], [1, '#01131A']]],
  ['gD', u(268), 0, u(473), 0, [                       // motion dashes
    [0, '#00E8D0'], [1, '#00CFBC']]],
];

const defs = grads.map(([id, x1, y1, x2, y2, stops]) =>
  `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">`
  + stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('') + '</linearGradient>').join('\n  ');

const pills = PILLS.map(([x, y, w]) =>
  `<rect x="${u(x)}" y="${u(y)}" width="${u(w)}" height="${u(16)}" rx="${u(8)}"/>`).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="PIE">
 <defs>
  ${defs}
 </defs>
 <path fill="url(#gA)" d="${P.tarc}"/>
 <path fill="url(#gB)" d="${P.barc}"/>
 <path fill="url(#gP)" d="${P.pisil}"/>
 <path fill="url(#gL)" d="${P.lleg}"/>
 <path fill="url(#gF)" d="${P.fold}"/>
 <g fill="url(#gD)">${pills}</g>
</svg>
`;
fs.writeFileSync('public/pie-logo.svg', svg);
console.log(`public/pie-logo.svg  ${svg.length} bytes, ${(svg.match(/<path|<rect/g) || []).length} shapes`);
