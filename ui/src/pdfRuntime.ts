// One shared pdf.js runtime for the compiled document, project PDF assets, and
// first-page thumbnails inside Live. A worker belongs to the whole browser
// window, not to one React component; configuring a second worker for every
// figure wastes memory and can leave concurrent PDF views talking to different
// ports.
import './mathSumPrecise';
import * as pdfjs from 'pdfjs-dist';
import patchedWorkerUrl from './pdfWorker.ts?worker&url';

// Our own worker module installs the Math.sumPrecise polyfill before loading
// pdf.js. Pointing workerSrc at it lets pdf.js own one worker per loading task,
// which matters now that the compiled PDF and several figure thumbnails may be
// open concurrently. A single externally supplied workerPort is cached and is
// destroyed when *any* one loading task is destroyed, blanking all the others.
// pdf.js also retains its built-in fake-worker recovery around workerSrc.
pdfjs.GlobalWorkerOptions.workerPort = null;
pdfjs.GlobalWorkerOptions.workerSrc = patchedWorkerUrl;

export { pdfjs };
