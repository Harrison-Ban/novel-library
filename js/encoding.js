// txt 인코딩 자동 판별: UTF-8, EUC-KR(CP949), UTF-16 (F16)
// 브라우저의 TextDecoder에서 'euc-kr'은 CP949(확장 완성형)까지 포함한다.

export const ENCODINGS = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'euc-kr', label: 'EUC-KR (CP949)' },
  { value: 'utf-16le', label: 'UTF-16 LE' },
  { value: 'utf-16be', label: 'UTF-16 BE' },
];

// 파일 앞부분 바이트로 판별한다. { encoding, bomLength }
export function detectEncoding(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: 'utf-8', bomLength: 3 };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: 'utf-16le', bomLength: 2 };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: 'utf-16be', bomLength: 2 };

  const sample = bytes.subarray(0, 256 * 1024);
  const utf16 = guessUtf16(sample);
  if (utf16) return { encoding: utf16, bomLength: 0 };
  if (isValidUtf8(sample)) return { encoding: 'utf-8', bomLength: 0 };
  return { encoding: 'euc-kr', bomLength: 0 };
}

// 잘린 끝부분(여러 바이트 글자의 중간)은 문제 삼지 않는다
function isValidUtf8(sample) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true });
    return true;
  } catch {
    return false;
  }
}

// BOM 없는 UTF-16: 영문·숫자·줄바꿈은 한쪽 바이트가 0이 된다
function guessUtf16(sample) {
  const n = Math.min(sample.length - (sample.length % 2), 8192);
  if (n < 4) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if (sample[i] === 0) evenZero++;
    if (sample[i + 1] === 0) oddZero++;
  }
  const pairs = n / 2;
  if (oddZero / pairs > 0.3 && evenZero / pairs < 0.05) return 'utf-16le';
  if (evenZero / pairs > 0.3 && oddZero / pairs < 0.05) return 'utf-16be';
  return null;
}

// 다 받은 뒤 UTF-8로 읽었는데 깨진 글자가 많으면 EUC-KR로 다시 읽을지 판단
export function looksMisdecoded(text) {
  let bad = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0xfffd) bad++;
  return bad > 3 && bad / Math.max(text.length, 1) > 0.0005;
}

export function decodeAll(chunks, encoding, bomLength = 0) {
  const decoder = new TextDecoder(encoding);
  let text = '';
  chunks.forEach((c, i) => {
    text += decoder.decode(i === 0 && bomLength ? c.subarray(bomLength) : c, { stream: true });
  });
  return text + decoder.decode();
}
