// pdf.js's worker, with the Math.sumPrecise polyfill installed first.
//
// A worker has its own global scope, so patching Math on the main thread does
// not reach the half of pdf.js that parses fonts and lays out text — which is
// where the missing method actually bites. Rather than pointing workerSrc at
// pdf.js's worker directly, we point it at this module, which polyfills and then
// loads the real thing.
import './mathSumPrecise';
export * from 'pdfjs-dist/build/pdf.worker.min.mjs';
