module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // The client's framework-free modules are tested here too: they hold shared
  // decision logic (the DVR vocabulary) that was previously only reachable
  // through a component, and so was never asserted on.
  roots: ['<rootDir>/src', '<rootDir>/client/src/app/services', '<rootDir>/client/src/app/admin/channels'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  // NodeNext requires .js specifiers in relative imports; strip them so jest
  // resolves the .ts source (and so those modules can be mocked by path).
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transform: {
    '^.+\\.(ts|tsx|js|jsx|mjs)$': ['ts-jest', { useESM: true }]
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    'client/src/app/services/dvr-format.ts',
    'client/src/app/admin/channels/channel-window.ts',
    '!src/**/*.d.ts',
    '!src/debug_*.ts',
    '!src/scripts/**',
    '!src/services/tui.ts',
    // Exclude files that are primarily configuration/routes
    '!src/server.ts',
    '!src/db.ts'
  ],
  coverageThreshold: {
    global: {
      branches: 2,
      functions: 10,
      lines: 10,
      statements: 10
    }
  },
  coverageDirectory: 'coverage',
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  transformIgnorePatterns: [
    'node_modules/(?!(iptv-playlist-parser|epg-grabber|@freearhey\\/core)/)'
  ]
};
