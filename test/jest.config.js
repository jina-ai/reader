/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  testEnvironment: "node",
  verbose: true,
  preset: 'ts-jest',
  moduleFileExtensions: [
    "js",
    "ts",
    "json",
    "node"
  ],
  transform: {
    "^.+\\.tsx?$": ["ts-jest",{
      tsconfig: "<rootDir>/test/tsconfig.test.json",
    }],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testMatch: [
    "<rootDir>/test/e2e/**/*.test.ts"
  ],
  setupFilesAfterEnv: [],
  testPathIgnorePatterns: [
    "<rootDir>/node_modules/",
    "<rootDir>/dist/",
  ],
  rootDir: '../',
  testTimeout: 30000,
};