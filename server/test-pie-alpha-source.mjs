// Offline wiring guard; pixel behavior is covered by the unexecuted native
// UEMCP.Capture.PieViewportOpaquePixels test, not simulated in JavaScript.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, TestRunner } from './test-helpers.mjs';

const t = new TestRunner('PIE Screenshot Alpha Source Checks');
const privateDir = join(REPO_ROOT, 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private');
const handlers = readFileSync(join(privateDir, 'AssetEditorCaptureHandler.cpp'), 'utf8');
const helperPath = join(privateDir, 'PieViewportPixels.h');
const helper = existsSync(helperPath) ? readFileSync(helperPath, 'utf8') : '';
const pieStart = handlers.indexOf('void HandleCapturePieViewport(');
const pieEnd = handlers.indexOf('void RegisterAssetEditorCaptureHandlers(', pieStart);
const pieBody = handlers.slice(pieStart, pieEnd);
const normalize = pieBody.indexOf('MakePieViewportPixelsOpaque(Bitmap);');
const imageView = pieBody.indexOf('const FImageView View(Bitmap.GetData(), Size.X, Size.Y);');

t.assert(handlers.includes('#include "PieViewportPixels.h"'),
  'PIE capture imports the private opaque-pixel helper');
t.assert(normalize > pieBody.indexOf('Bitmap.Num() < Size.X * Size.Y') && normalize < imageView,
  'PIE pixels become opaque after readback validation and before the original dimensioned image view');
t.assert(/for\s*\(FColor& Pixel : Pixels\)\s*\{\s*Pixel\.A = 255;\s*\}/.test(helper),
  'opaque-pixel loop changes only alpha, preserving RGB and pixel count');
t.assert((handlers.match(/MakePieViewportPixelsOpaque\(Bitmap\);/g) || []).length === 1 && normalize !== -1,
  'opaque normalization is confined to the PIE capture handler');
t.assert(pieBody.indexOf('FImageUtils::CompressImage(Png, TEXT("png"), View, 0);') > imageView &&
  pieBody.includes('FinishCapture(Png, Size, OutputPath, bInline, Result, ErrorMessage)'),
  'PIE PNG compression and shared disk/inline delivery keep the same buffer and dimensions');
for (const name of ['AssetEditorCapture.cpp', 'VisualCaptureHandler.cpp']) {
  t.assert(!readFileSync(join(privateDir, name), 'utf8').includes('MakePieViewportPixelsOpaque'),
    `${name} retains its existing alpha policy`);
}

process.exit(t.summary());
