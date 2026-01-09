module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  collectCoverageFrom: [
    'src/**/*.ts',
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
    'node_modules/(?!(iptv-playlist-parser)/)'
  ]
};
