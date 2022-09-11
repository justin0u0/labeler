import { checkGlobs, GlobalMatchConfig } from "../src/labeler";

import * as core from "@actions/core";

jest.mock("@actions/core");

beforeAll(() => {
  jest.spyOn(core, "getInput").mockImplementation((name, options) => {
    return jest.requireActual("@actions/core").getInput(name, options);
  });
});

describe.each([
  {
    matchConfig: [{ all: ["*.txt"] }],
    changedFiles: ["foo.txt", "bar.txt"],
    expected: true,
  },
  {
    matchConfig: [{ all: ["*.txt"] }],
    changedFiles: ["foo.txt", "bar.docx"],
    expected: false,
  },
  {
    matchConfig: [{ all: { or: ['pkg/modules/a/**', 'go.mod', 'go.sum'] } }],
    changedFiles: ["pkg/modules/a/foo.txt", "go.mod"],
    expected: true,
  },
  {
    matchConfig: [{ all: { or: ['pkg/modules/a/**', 'go.mod', 'go.sum'] } }],
    changedFiles: ["pkg/modules/b/foo.txt", "go.mod"],
    expected: false,
  },
  {
    matchConfig: [{ any: ["*.txt"] }],
    changedFiles: ["foo.txt", "bar.docx"],
    expected: true,
  },
  {
    matchConfig: [{ any: ["*.txt"] }],
    changedFiles: ["foo.docx", "bar.docx"],
    expected: false,
  }
] as {
  matchConfig: GlobalMatchConfig;
  changedFiles: string[];
  expected: boolean;
}[])("checkGlobs: %j", ({ matchConfig, changedFiles, expected }) => {
  it("succeeds", () => {
    const result = checkGlobs(changedFiles, matchConfig);

    expect(result).toBe(expected);
  });
});
