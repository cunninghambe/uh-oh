import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@uh-oh/types': path.resolve(here, '../types/src/index.ts'),
      'react-native': path.resolve(here, 'src/__test-stubs__/react-native.ts'),
      '@react-native-async-storage/async-storage': path.resolve(
        here,
        'src/__test-stubs__/async-storage.ts',
      ),
    },
  },
});
