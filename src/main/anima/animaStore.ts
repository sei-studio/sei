/** The app's anima pack store (261105): <userData>/anima. Light on purpose (facepackStore imports it). */
import { paths } from '../paths';
import { AnimaPackStore } from './animaPacks';

export const animaStore = new AnimaPackStore(() => paths.animaDir());
