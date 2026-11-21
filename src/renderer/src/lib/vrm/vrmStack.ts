/**
 * The VRM render stack (261122, experimental): three.js, its GLTFLoader and
 * @pixiv/three-vrm, in ONE module so VrmView's single dynamic import pulls
 * them as one lazy chunk. Nothing else may import this file statically:
 * surfaces that never show a VRM pay nothing.
 *
 * three is also in the entry chunk (chess), so Rollup puts it in a chunk both
 * share, holding every export either side uses. Name each class here, never
 * `export * as THREE`: a namespace re-export keeps all of three.js in that
 * shared chunk, which the entry loads at startup.
 */
export { Box3, DirectionalLight, HemisphereLight, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
export { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
