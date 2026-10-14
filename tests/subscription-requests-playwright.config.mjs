import {defineConfig} from '@playwright/test';
import path from 'node:path';
const baseURL=process.env.MAM_SR_ORIGIN;
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseURL??'')) throw new Error('Owned loopback request fixture required');
const outputDir=process.env.MAM_SR_OUTPUT_DIR;
if(!outputDir || !path.isAbsolute(outputDir)) throw new Error('Owned absolute browser output directory required');
export default defineConfig({testDir:'.',testMatch:'subscription-requests-browser.spec.mjs',workers:1,retries:0,timeout:20000,outputDir,use:{baseURL,browserName:'chromium',headless:true},reporter:'list'});
