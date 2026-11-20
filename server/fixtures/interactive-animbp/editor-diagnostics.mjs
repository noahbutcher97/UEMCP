// This exception identifies the observed stock UE 5.3.2 offscreen-startup ensure.
// It is retained as a diagnostic, not treated as a clean editor run.
export function classifyEditorEnsures(log, engineVersion) {
  const lines = log.replace(/^\uFEFF/, '').split(/\r?\n/);
  const indices = (pattern) => lines.flatMap((line, index) => pattern.test(line) ? [index] : []);
  const opens = indices(/^Log file open, /);
  const initialized = indices(/LogLoad: \(Engine Initialization\) Total time: /);
  const exits = indices(/LogExit: Exiting\.$/);
  const closes = indices(/Log file closed, /);
  const lastContent = lines.findLastIndex((line) => line.trim());
  const completeLog = opens.length === 1 && opens[0] === 0 && initialized.length === 1 &&
    exits.length === 1 && closes.length === 1 && opens[0] < initialized[0] &&
    initialized[0] < exits[0] && exits[0] < closes[0] && closes[0] === lastContent;
  const banners = indices(/=== Handled ensure: ===/);
  const conditions = indices(/Ensure condition failed:/);
  const usedBanners = new Set();
  const knownEngine = engineVersion.MajorVersion === 5 && engineVersion.MinorVersion === 3 &&
    engineVersion.PatchVersion === 2 && engineVersion.Changelist === 29314046 &&
    engineVersion.IsLicenseeVersion === 0 && engineVersion.IsPromotedBuild === 1 &&
    engineVersion.BranchName === '++UE5+Release-5.3';
  const knownMessage = /^Ensure condition failed: SwapChain4\.GetReference\(\)\s+\[File:D:\\build\\\+\+UE5\\Sync\\Engine\\Source\\Runtime\\D3D12RHI\\Private\\Windows\\WindowsD3D12Viewport\.cpp\] \[Line: 473\]\s*$/;
  const prefix = (line) => line.match(/^(\[[^\]]+\])\[\s*(\d+)\]LogOutputDevice: Error:/);
  let knownCount = 0;
  const observations = conditions.map((index) => {
    const message = lines[index].slice(lines[index].indexOf('Ensure condition failed:'));
    const conditionPrefix = prefix(lines[index]);
    const banner = banners.findLast((candidate) => candidate < index && index - candidate <= 3 && !usedBanners.has(candidate));
    const bannerPrefix = banner === undefined ? null : prefix(lines[banner]);
    const locallyPaired = !!conditionPrefix && !!bannerPrefix && conditionPrefix[1] === bannerPrefix[1] &&
      conditionPrefix[2] === bannerPrefix[2];
    if (locallyPaired) usedBanners.add(banner);
    const startup = locallyPaired && conditionPrefix[2] === '0' && index < initialized[0];
    const known = completeLog && knownEngine && knownMessage.test(message) && startup && knownCount === 0;
    if (known) knownCount++;
    return { line: index + 1, message, bannerLine: locallyPaired ? banner + 1 : null,
      classification: known ? 'known-ue532-offscreen-swapchain' : 'unexpected',
      startup, locallyPaired };
  });
  const unexpectedCount = observations.length - knownCount;
  const unmatchedBannerCount = banners.length - usedBanners.size;
  return {
    engineVersion,
    completeLog,
    boundaries: { open: opens.map((n) => n + 1), initialized: initialized.map((n) => n + 1),
      exit: exits.map((n) => n + 1), closed: closes.map((n) => n + 1) },
    handledEnsureBanners: banners.length,
    conditionCount: conditions.length,
    knownCount,
    unexpectedCount,
    unmatchedBannerCount,
    observations,
    passed: completeLog && unexpectedCount === 0 && unmatchedBannerCount === 0,
  };
}
