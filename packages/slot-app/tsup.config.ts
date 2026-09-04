import { defineConfig } from 'tsup';
import { slotAppVersionDefine } from './version-define';

export default defineConfig({
  // Substitutes src/version.ts's placeholder from package.json.
  define: slotAppVersionDefine,
  // Named entries so the CLI lands at dist/cli.js (not dist/slot-app/cli.js)
  // for the `slot-app` bin and the "./cli" export.
  entry: {
    index: 'src/index.ts',
    cli: 'src/slot-app/cli.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  // cli.ts begins with `#!/usr/bin/env node`; tsup preserves the shebang and
  // marks dist/cli.js executable for the `slot-app` bin.
});
