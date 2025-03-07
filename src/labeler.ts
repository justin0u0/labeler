import * as core from "@actions/core";
import * as github from "@actions/github";
import * as yaml from "js-yaml";
import { Minimatch, IMinimatch } from "minimatch";

type MatchRule = { and?: string[]; or?: string[] };

interface MatchConfig {
  all?: string[] | MatchRule;
  any?: string[] | MatchRule;
}

type StringOrMatchConfig = string | MatchConfig;
type ClientType = ReturnType<typeof github.getOctokit>;

export type GlobalMatchConfig = StringOrMatchConfig[];

export async function run() {
  try {
    const token = core.getInput("repo-token", { required: true });
    const configPath = core.getInput("configuration-path", { required: true });
    const syncLabels = !!core.getInput("sync-labels", { required: false });

    const prNumber = getPrNumber();
    if (!prNumber) {
      console.log("Could not get pull request number from context, exiting");
      return;
    }

    const client: ClientType = github.getOctokit(token);

    const { data: pullRequest } = await client.rest.pulls.get({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: prNumber,
    });

    core.debug(`fetching changed files for pr #${prNumber}`);
    const changedFiles: string[] = await getChangedFiles(client, prNumber);
    const labelGlobs: Map<string, StringOrMatchConfig[]> = await getLabelGlobs(
      client,
      configPath
    );

    const labels: string[] = [];
    const labelsToRemove: string[] = [];
    for (const [label, globs] of labelGlobs.entries()) {
      core.debug(`processing ${label}`);
      if (checkGlobs(changedFiles, globs)) {
        labels.push(label);
      } else if (pullRequest.labels.find((l) => l.name === label)) {
        labelsToRemove.push(label);
      }
    }

    if (labels.length > 0) {
      await addLabels(client, prNumber, labels);
    }

    if (syncLabels && labelsToRemove.length) {
      await removeLabels(client, prNumber, labelsToRemove);
    }
  } catch (error: any) {
    core.error(error);
    core.setFailed(error.message);
  }
}

function getPrNumber(): number | undefined {
  const pullRequest = github.context.payload.pull_request;
  if (!pullRequest) {
    return undefined;
  }

  return pullRequest.number;
}

async function getChangedFiles(
  client: ClientType,
  prNumber: number
): Promise<string[]> {
  const listFilesOptions = client.rest.pulls.listFiles.endpoint.merge({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: prNumber,
  });

  const listFilesResponse = await client.paginate(listFilesOptions);
  const changedFiles = listFilesResponse.map((f: any) => f.filename);

  core.debug("found changed files:");
  for (const file of changedFiles) {
    core.debug("  " + file);
  }

  return changedFiles;
}

async function getLabelGlobs(
  client: ClientType,
  configurationPath: string
): Promise<Map<string, StringOrMatchConfig[]>> {
  const configurationContent: string = await fetchContent(
    client,
    configurationPath
  );

  // loads (hopefully) a `{[label:string]: string | StringOrMatchConfig[]}`, but is `any`:
  const configObject: any = yaml.load(configurationContent);

  // transform `any` => `Map<string,StringOrMatchConfig[]>` or throw if yaml is malformed:
  return getLabelGlobMapFromObject(configObject);
}

async function fetchContent(
  client: ClientType,
  repoPath: string
): Promise<string> {
  const response: any = await client.rest.repos.getContent({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    path: repoPath,
    ref: github.context.sha,
  });

  return Buffer.from(response.data.content, response.data.encoding).toString();
}

function getLabelGlobMapFromObject(
  configObject: any
): Map<string, StringOrMatchConfig[]> {
  const labelGlobs: Map<string, StringOrMatchConfig[]> = new Map();
  for (const label in configObject) {
    if (typeof configObject[label] === "string") {
      labelGlobs.set(label, [configObject[label]]);
    } else if (configObject[label] instanceof Array) {
      labelGlobs.set(label, configObject[label]);
    } else {
      throw Error(
        `found unexpected type for label ${label} (should be string or array of globs)`
      );
    }
  }

  return labelGlobs;
}

function toMatchConfig(config: StringOrMatchConfig): MatchConfig {
  if (typeof config === "string") {
    return {
      any: [config],
    };
  }

  return config;
}

function printPattern(matcher: IMinimatch): string {
  return (matcher.negate ? "!" : "") + matcher.pattern;
}

export function checkGlobs(
  changedFiles: string[],
  globs: StringOrMatchConfig[]
): boolean {
  for (const glob of globs) {
    core.debug(` checking pattern ${JSON.stringify(glob)}`);
    const matchConfig = toMatchConfig(glob);
    if (checkMatch(changedFiles, matchConfig)) {
      return true;
    }
  }
  return false;
}

function isMatchAll(changedFile: string, matchers: IMinimatch[]): boolean {
  core.debug(`    matching all patterns against file ${changedFile}`);
  for (const matcher of matchers) {
    core.debug(`   - ${printPattern(matcher)}`);
    if (!matcher.match(changedFile)) {
      core.debug(`   ${printPattern(matcher)} did not match`);
      return false;
    }
  }

  core.debug(`   all patterns matched`);
  return true;
}

function isMatchAny(changedFile: string, matchers: IMinimatch[]): boolean {
  if (matchers.length === 0) {
    return true;
  }
  
  core.debug(`    matching any patterns against file ${changedFile}`);
  for (const matcher of matchers) {
    core.debug(`   - ${printPattern(matcher)}`);
    if (matcher.match(changedFile)) {
      core.debug(`   ${printPattern(matcher)} matched`);
      return true;
    }
  }

  core.debug(`   no patterns matched`);
  return false;
}

// equivalent to "Array.some()" but expanded for debugging and clarity
function checkAny(changedFiles: string[], matcherAll: IMinimatch[] = [], matcherAny: IMinimatch[] = []): boolean {
  core.debug(`  checking "any" patterns with "all" matchers`);
  for (const changedFile of changedFiles) {
    if (isMatchAll(changedFile, matcherAll) && isMatchAny(changedFile, matcherAny)) {
      core.debug(`  "any" patterns matched against ${changedFile}`);
      return true;
    }
  }

  core.debug(`  "any" patterns did not match any files`);
  return false;
}

// equivalent to "Array.every()" but expanded for debugging and clarity
function checkAll(changedFiles: string[], matcherAll: IMinimatch[] = [], matcherAny: IMinimatch[] = []): boolean {
  core.debug(` checking "all" patterns with "all" matchers`);
  for (const changedFile of changedFiles) {
    if (!isMatchAll(changedFile, matcherAll)) {
      core.debug(`  "all" patterns did not match against ${changedFile}`);
      return false;
    }
  }

  core.debug(` checking "all" patterns with "any" matchers`);
  for (const changedFile of changedFiles) {
    if (!isMatchAny(changedFile, matcherAny)) {
      core.debug(`  "all" patterns did not match against ${changedFile}`);
      return false;
    }
  }

  core.debug(`  "all" patterns matched all files`);
  return true;
}

function checkMatch(changedFiles: string[], matchConfig: MatchConfig): boolean {

  if (matchConfig.all !== undefined) {
    const { matcherAll, matcherAny } = toMatchers(matchConfig.all);
    if (!checkAll(changedFiles, matcherAll, matcherAny)) {
      return false;
    }
  }

  if (matchConfig.any !== undefined) {
    const { matcherAll, matcherAny } = toMatchers(matchConfig.any);
    if (!checkAny(changedFiles, matcherAll, matcherAny)) {
      return false;
    }
  }

  return true;
}

function toMatchers(config: string[] | MatchRule): { matcherAll: IMinimatch[], matcherAny: IMinimatch[] } {
  let matcherAll: IMinimatch[] = [];
  let matcherAny: IMinimatch[] = [];

  if (Array.isArray(config)) {
    matcherAll = matcherAll.concat(config.map((g) => new Minimatch(g)));
  } else {
    if (config.and !== undefined) {
      matcherAll = matcherAll.concat(config.and.map((g) => new Minimatch(g)));
    }
    if (config.or !== undefined) {
      matcherAny = matcherAny.concat(config.or.map((g) => new Minimatch(g)));
    }
  }

  return { matcherAll, matcherAny };
}

async function addLabels(
  client: ClientType,
  prNumber: number,
  labels: string[]
) {
  await client.rest.issues.addLabels({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: prNumber,
    labels: labels,
  });
}

async function removeLabels(
  client: ClientType,
  prNumber: number,
  labels: string[]
) {
  await Promise.all(
    labels.map((label) =>
      client.rest.issues.removeLabel({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        issue_number: prNumber,
        name: label,
      })
    )
  );
}
