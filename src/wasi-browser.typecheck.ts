import binding, {
  __napiBindingTarget,
  _prepareRegexSet,
  _uax29Boundaries,
  RegexSet,
} from "../regex-set.wasi-browser.js";

const patterns = ["browser"];
const prepared = _prepareRegexSet(patterns);
const regexSet = new RegexSet(patterns, null, prepared);
const boundaries = _uax29Boundaries(prepared);

void [binding.RegexSet, regexSet, boundaries, __napiBindingTarget];
