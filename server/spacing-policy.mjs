// One-step contextual bandit. Reward +1 for the correct accept/reject decision,
// -1 otherwise. The two policy parameters are a bias and a clearance weight.
export function trainSpacingPolicy(report, steps, progress = () => {}) {
  if (!Number.isInteger(steps) || steps < 32 || steps > 8192) throw new Error('Training requires 32–8192 steps.');
  let state = report.seed >>> 0;
  const uniform = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const weights = [0, 0];
  const probability = x => 1 / (1 + Math.exp(-(weights[0] + weights[1] * x)));
  let completed = 0, baseline = 0, totalReward = 0;
  while (completed < steps) {
    const batch = [];
    const count = Math.min(32, steps - completed);
    for (let i = 0; i < count; i++) {
      const row = report.starts[Math.floor(uniform() * report.starts.length)];
      const x = Math.tanh((row.nearest_metres - report.threshold_metres) / Math.max(report.threshold_metres, 0.001));
      const p = probability(x);
      const action = uniform() < p ? 1 : 0;
      const reward = Boolean(action) === row.meets_minimum ? 1 : -1;
      batch.push({ x, action, reward, oldProb: action ? p : 1 - p });
      totalReward += reward;
    }
    for (let epoch = 0; epoch < 4; epoch++) {
      let bias = 0, slope = 0;
      for (const sample of batch) {
        const p = probability(sample.x);
        const ratio = (sample.action ? p : 1 - p) / sample.oldProb;
        const advantage = sample.reward - baseline;
        if ((advantage > 0 && ratio > 1.2) || (advantage < 0 && ratio < 0.8)) continue;
        const gradient = ratio * advantage * (sample.action - p);
        bias += gradient;
        slope += gradient * sample.x;
      }
      weights[0] += 0.2 * bias / count;
      weights[1] += 0.2 * slope / count;
    }
    baseline = batch.reduce((sum, s) => sum + s.reward, 0) / count;
    completed += count;
    progress(completed);
  }
  return { format: 'uemcp.spacing-policy.v1', algorithm: 'clipped_ppo', action: 'accept_player_start',
    feature: 'tanh((nearest_metres-threshold_metres)/max(threshold_metres,0.001))',
    seed: report.seed, steps: completed, clip: 0.2, epochs_per_batch: 4, weights, mean_reward: totalReward / steps };
}
