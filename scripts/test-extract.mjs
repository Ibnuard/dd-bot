import { extractVideos } from '../extractor.js';

const url = process.argv[2] || 'https://www.eporner.com/video-qo6GuqnYM15/thick-asian-teen-masturbating-and-fucked/';
console.log('extracting:', url);
const videos = await extractVideos(url);
console.log('result:', videos);
