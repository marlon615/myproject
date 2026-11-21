/** Picks the best deep, natural male voice the phone has (voices differ per phone; a choice is saved on that phone). */
export const VOICE_PICK_JS = String.raw`
var CHIEF_MALE = /\b(aaron|arthur|daniel|evan|fred|gordon|nathan|oliver|tom|alex|reed|rishi|ralph|albert|bruce|junior|lee|rocko|eddy|grandpa|guy|andrew|brian|christopher|eric|davis|david|mark|ryan|thomas|william|liam|james|george|roger|steffan|jason|tony|brandon|kai|luke|male|man)\b/i;
var CHIEF_FEMALE = /\b(samantha|karen|moira|tessa|victoria|allison|ava|susan|zoe|zoey|nicky|joelle|serena|kate|fiona|martha|catherine|veena|kathy|princess|vicki|agnes|flo|grandma|sandy|shelley|zira|aria|jenny|michelle|emma|sonia|libby|natasha|clara|female|woman|susan|siri female)\b/i;
// Android's built-in Google voices use codes instead of names.
var CHIEF_ANDROID_MALE = /x-(iol|iom|tpd|gbd|rjs|aub|aud|gbg|ene|end)-/i, CHIEF_ANDROID_FEMALE = /x-(sfg|iob|iog|tpc|tpf|gba|gbc|aua|auc|enc)-/i;
function chiefVoiceScore(v, lang){
  var n = (v.name || "") + " " + (v.voiceURI || ""), s = 0;
  if (CHIEF_MALE.test(n) || CHIEF_ANDROID_MALE.test(n)) s += 100;
  if (CHIEF_FEMALE.test(n) || CHIEF_ANDROID_FEMALE.test(n)) s -= 200;
  if (/premium/i.test(n)) s += 45; else if (/enhanced|neural|natural|online/i.test(n)) s += 35;
  if (/compact|eloquence/i.test(n)) s -= 15;
  if (/\b(fred|junior|ralph|albert|bruce|grandpa|rocko|eddy|zarvox|trinoids|whisper|bad news|good news|bells|boing|bubbles|cellos|organ|superstar|wobble|jester)\b/i.test(n)) s -= 55; // robotic novelty voices
  if (/-network\b/i.test(n)) s += 8; // Android's higher-quality online voices
  var l = (v.lang || "").toLowerCase().replace("_", "-");
  if (l === lang) s += 12; else if (l.slice(0, 2) === lang.slice(0, 2)) s += 6; else s -= 60;
  if (l === "en-us") s += 4;
  return s;
}
function chiefPickVoice(){
  if (!("speechSynthesis" in window)) return { voice: null, male: false };
  var list = (speechSynthesis.getVoices ? speechSynthesis.getVoices() : []) || [];
  var lang = (navigator.language || "en-US").toLowerCase();
  var saved = null; try { saved = localStorage.getItem("chiefVoice"); } catch (e) {}
  if (saved) for (var i = 0; i < list.length; i++) if (list[i].voiceURI === saved) return { voice: list[i], male: chiefVoiceScore(list[i], lang) >= 60, chosen: true };
  var best = null, bestScore = -1e9;
  for (var j = 0; j < list.length; j++) { var sc = chiefVoiceScore(list[j], lang); if (sc > bestScore) { best = list[j]; bestScore = sc; } }
  return { voice: best, male: bestScore >= 60 };
}
function chiefMaleVoices(){
  var list = ("speechSynthesis" in window && speechSynthesis.getVoices ? speechSynthesis.getVoices() : []) || [];
  var lang = (navigator.language || "en-US").toLowerCase();
  return list.map(function(v){ return { v: v, s: chiefVoiceScore(v, lang) }; })
    .filter(function(x){ return x.s >= 30; })
    .sort(function(a, b){ return b.s - a.s; })
    .map(function(x){ return x.v; });
}
// Slightly deeper and calmer than the voice's default, without sounding processed.
var CHIEF_PITCH = 0.9, CHIEF_RATE = 0.97;
`;
