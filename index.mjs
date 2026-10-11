// ES module entry for bundlers and Node: `import Spritewright from 'spritewright'`.
// The editor itself is one classic file (spritewright.js) that also works with a plain <script> tag; importing it registers window/globalThis.Spritewright.
import './spritewright.js';
const PF = globalThis.Spritewright;
export default PF;
export const { mount, createPullRequest, prBody, png, sources, auth, core } = PF;
