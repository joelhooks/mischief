const escape = 0x1b;

const codeAt = (value: string, index: number) => value.codePointAt(index) ?? -1;

const endString = (value: string, start: number, osc: boolean) => {
  for (let index = start; index < value.length; index += 1) {
    const code = codeAt(value, index);

    if (code === 0x9c || (osc && code === 7)) {
      return index + 1;
    }

    if (code === escape && codeAt(value, index + 1) === 0x5c) {
      return index + 2;
    }
  }

  return value.length;
};

const endCsi = (value: string, start: number) => {
  for (let index = start; index < value.length; index += 1) {
    const code = codeAt(value, index);

    if (code === escape || (code >= 0x80 && code <= 0x9f)) {
      return index;
    }

    if (code >= 0x40 && code <= 0x7e) {
      return index + 1;
    }
  }

  return value.length;
};

const endEscape = (value: string, start: number) => {
  const introducer = value[start];

  if (introducer === "[") {
    return endCsi(value, start + 1);
  }

  if (
    introducer === "]" ||
    introducer === "P" ||
    introducer === "X" ||
    introducer === "^" ||
    introducer === "_"
  ) {
    return endString(value, start + 1, introducer === "]");
  }

  let index = start;
  let code = codeAt(value, index);

  while (code >= 0x20 && code <= 0x2f) {
    index += 1;
    code = codeAt(value, index);
  }

  return code >= 0x30 && code <= 0x7e ? index + 1 : index;
};

const endControl = (value: string, index: number) => {
  const code = codeAt(value, index);

  switch (code) {
    case escape: {
      return endEscape(value, index + 1);
    }

    case 0x9b: {
      return endCsi(value, index + 1);
    }

    case 0x90:
    case 0x98:
    case 0x9d:
    case 0x9e:
    case 0x9f: {
      return endString(value, index + 1, code === 0x9d);
    }

    default: {
      return index + 1;
    }
  }
};

const stripControls = (value: string) => {
  const out: string[] = [];
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const code = codeAt(value, index);

    if (
      (code < 32 && code !== 9 && code !== 10) ||
      (code >= 127 && code <= 159) ||
      (code >= 0x20_0b && code <= 0x20_0f) ||
      (code >= 0x20_2a && code <= 0x20_2e) ||
      code === 0xad ||
      code === 0x06_1c ||
      code === 0x18_0e ||
      (code >= 0x20_60 && code <= 0x20_69 && code !== 0x20_65) ||
      code === 0xfe_ff
    ) {
      out.push(value.slice(start, index));
      start = endControl(value, index);
      index = start - 1;
    }
  }

  out.push(value.slice(start));

  return out.join("");
};

const pemBlock =
  /-----BEGIN [A-Z0-9][A-Z0-9 -]{0,64}-----[\s\S]*?(?:-----END [A-Z0-9][A-Z0-9 -]{0,64}-----|$)/giu;

const authorization = /\b(?:proxy-)?authorization\b["']?[ \t]*[:=][^\n]*/giu;

const bearer = /\bbearer[ \t]+[^\s"'`,;)}\]]+/giu;

const namedSecret =
  /\b(?:[\w-]{0,64}model[-_ ]?route[-_ ]?(?:api[-_ ]?)?key|[\w-]{0,64}(?:api[-_ ]?key|token|secret(?:[-_ ]?key)?|password|private[-_ ]?key|database[-_ ]?url))["']?[ \t]*[:=][ \t]*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;)}\]]+)/giu;

const providerKey =
  /\b(?:sk-[a-z0-9_-]{8,}|(?:gh[pors]_|github_pat_)[a-z0-9_]{8,}|(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16}|(?:mischief[-_])?model[-_]route[-_](?:[a-z0-9_-]{8,}))/giu;

const wholeJwt = /eyJ[\w-]+\.[\w-]+\.[\w-]*/gu;

const tokenRun =
  /(?<![A-Za-z0-9+/_-])(?:(?:[a-f0-9]{40,})(?![A-Za-z0-9+/_-])|[A-Za-z0-9+/_-]{40,}={0,2})(?![A-Za-z0-9+/_-])/giu;

const tokenLike = (value: string) =>
  /^[a-f0-9]+$/iu.test(value) ||
  (/[a-z]/u.test(value) && /[A-Z]/u.test(value) && /\d/u.test(value)) ||
  /[+/=]/u.test(value);

export const sanitizeTailText = (value: string) =>
  stripControls(value)
    .replaceAll(pemBlock, "[redacted]")
    .replaceAll(authorization, "[redacted]")
    .replaceAll(bearer, "[redacted]")
    .replaceAll(namedSecret, "[redacted]")
    .replaceAll(wholeJwt, "[redacted]")
    .replaceAll(providerKey, "[redacted]")
    .replaceAll(tokenRun, (run) => (tokenLike(run) ? "[redacted]" : run));

const encoder = new TextEncoder();

export const tailJsonBytes = (value: string) =>
  encoder.encode(value).byteLength;

export const clipTailText = (value: string, budget: number) => {
  if (tailJsonBytes(JSON.stringify(value)) <= budget) {
    return value;
  }

  const parts: string[] = [];
  let remaining = budget - 5;

  for (const character of value) {
    const bytes = tailJsonBytes(JSON.stringify(character)) - 2;

    if (bytes > remaining) {
      break;
    }

    parts.push(character);
    remaining -= bytes;
  }

  return `${parts.join("")}…`;
};

export const previewTailText = (value: string, budget: number) =>
  clipTailText(sanitizeTailText(value), budget);
