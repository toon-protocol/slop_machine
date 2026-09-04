import { defineConfig } from 'tsup';
import { stationOriginVersionDefine } from './version-define';

export default defineConfig({
  // Substitutes src/version.ts's placeholder from package.json.
  define: stationOriginVersionDefine,
  // Named entries so the CLI lands at dist/cli.js (not dist/origin/cli.js)
  // for the `station-origin` bin and the "./cli" export.
  entry: {
    index: 'src/index.ts',
    cli: 'src/origin/cli.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  // cli.ts begins with `#!/usr/bin/env node`; tsup preserves the shebang and
  // marks dist/cli.js executable for the `station-origin` bin.
});
