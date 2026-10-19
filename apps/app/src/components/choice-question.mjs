import { unified } from 'unified';
import remarkParse from 'remark-parse';

const parser = unified().use(remarkParse);
function plain(node) {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (['paragraph', 'strong', 'emphasis'].includes(node.type)) {
    const children = node.children.map(plain);
    return children.every(value => value !== null) ? children.join('') : null;
  }
  return null;
}

function invitesChoice(question) {
  return (/[?？]/.test(question) && /(哪(?:一|個|份|種)|選擇|選項|which|choose|select|prefer|would you like)/i.test(question)) ||
    /(?:要先|要不要|是否|需不需要|可以先|應該)[^。！？\n]{1,500}(?:嗎|呢)[?？]\s*$/.test(question.trim()) ||
    /(?:^|[?？]\s*)(?:還是|或是|抑或|或者)[^。！？\n]{1,240}[?？]/.test(question.trim()) ||
    /(?:^|\?\s*)or\s+[^.!?\n]{1,240}\?/i.test(question.trim()) ||
    /(?:是指|要|想|希望|選)[^。！？\n]{0,180}(?:還是|或是|抑或)[^。！？\n]{1,180}[?？]/.test(question) ||
    /\b(?:should|would|do|did|are|is|want|prefer)\b[^.!?\n]{0,180}\bor\b[^.!?\n]{1,180}\?/i.test(question) ||
    /(?:請(?:你|您)?(?:選|挑)|(?:隨機|隨意|任選)[^。！？\n]{0,24}選|(?:你|您)(?:可以|可|想要|希望)[^。！？\n]{0,40}(?:選|挑)|\b(?:please\s+)?(?:choose|select|pick)\s+(?:one|an?\s+option)\b)/i.test(question);
}

function requestsOptions(text) {
  return typeof text === 'string' && text.length <= 2048 &&
    !/(?:不要|不需|無需|不用)[^。！？\n]{0,24}(?:選項|選擇)|\b(?:do not|don't|no need to)\b[^.!?\n]{0,40}(?:options|choices)/i.test(text) &&
    /(?:給我|提供|列出|產生|生成|給出)[^。！？\n]{0,48}選項|選項[^。！？\n]{0,48}(?:讓我|供我|我(?:來|可以))選|\b(?:give|list|provide|generate)\b[^.!?\n]{0,80}\b(?:options|choices)\b/i.test(text);
}

export function choiceQuestion(text, userPrompt = '') {
  if (typeof text !== 'string' || text.length > 131072) return null;
  const nodes = parser.parse(text).children;
  const list = nodes.at(-1), prompt = nodes.at(-2);
  // A list-only reply is selectable only when its own turn explicitly requested options.
  if (list?.type !== 'list' || list.children.length < 2 || list.children.length > 6) return null;
  const question = prompt?.type === 'paragraph' ? plain(prompt) : nodes.length === 1 && requestsOptions(userPrompt) ? userPrompt.trim() : null;
  if (!question || question.length > 2048 || (prompt && !invitesChoice(question))) return null;
  const labels = list.children.map(item => item.children.length === 1 ? plain(item.children[0])?.trim() : null);
  if (labels.some(label => !label || label.length > 240 || /[\r\n]/.test(label) || /^\[[ xX]\]/.test(label)) || new Set(labels).size !== labels.length) return null;
  return { before: text.slice(0, list.position.start.offset).trimEnd(), question, options: labels.map(label => ({ label, description: '' })) };
}
