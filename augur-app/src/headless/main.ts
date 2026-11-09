import { configFromEnv, runHeadless } from './run';

async function main() {
  const cfg = configFromEnv(process.env, process.argv.slice(2));
  const r = await runHeadless(cfg);
  process.stdout.write(`${r.answer}\n`);
  return r.stopReason === 'error' ? 1 : 0;
}

main().then(
  (code) => (process.exitCode = code),
  (e) => {
    process.stderr.write(`augur-headless: ${(e as Error)?.message ?? e}\n`);
    process.exitCode = 2;
  }
);
