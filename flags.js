// Healing on/off switch shared by supervisor and app (file flag, cached 300ms)
const fs = require("fs"),
  p = __dirname + "/data/healing.off";
let t = 0,
  v = true;
module.exports = () => {
  if (Date.now() - t > 300) {
    v = !fs.existsSync(p);
    t = Date.now();
  }
  return v;
};
