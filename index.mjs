// ES module entry for bundlers and Node: `import PixelForge from 'pixel-forge'`.
// The editor itself is one classic file (pixel-forge.js) that also works with a plain <script> tag; importing it registers window/globalThis.PixelForge.
import './pixel-forge.js';
const PF = globalThis.PixelForge;
export default PF;
export const { mount, createPullRequest, prBody, png, sources, core } = PF;
