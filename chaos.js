// Usage: node chaos.js <crash|freeze|dbslow|dbdown|corrupt|corrupt-both|flood|healing-on|healing-off|reseed|all>
const B = "http://localhost:5200",
  K = {
    crash: "process",
    freeze: "process",
    dbslow: "db",
    dbdown: "db",
    corrupt: "data",
    "corrupt-both": "data",
    flood: "traffic",
    "pdf-fail": "download",
    "print-fail": "print",
  };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  post = (p) => fetch(B + "/chaos/" + p, { method: "POST" }),
  status = () => fetch(B + "/api/status").then((r) => r.json());
async function run(t, roll) {
  const t0 = Date.now();
  await post(t + (roll ? "?roll=" + roll : ""));
  if (t === "flood") setTimeout(() => post("stop-flood"), 8000);
  let inc;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    inc = (await status()).incidents.find(
      (x) => x.kind === K[t] && x.injectedAt >= t0 - 100,
    );
    if (inc && inc.state !== "open") break;
  }
  return {
    failure: t,
    result: inc ? inc.state : "no incident (healing off?)",
    detect_s: inc?.ttd,
    recover_s: inc?.ttr,
  };
}
(async () => {
  const a = process.argv[2];
  if (!a)
    return console.log(
      "Usage: node chaos.js <" +
        Object.keys(K)
          .concat(["healing-on", "healing-off", "reseed", "all"])
          .join("|") +
        ">",
    );
  if (a === "all") {
    const out = [];
    for (const t of [
      "dbslow",
      "dbdown",
      "corrupt",
      "pdf-fail",
      "print-fail",
      "flood",
      "freeze",
      "crash",
    ]) {
      console.log("Injecting", t);
      out.push(await run(t));
      await sleep(3000);
    }
    console.table(out);
    require("fs").writeFileSync(
      "chaos-results.json",
      JSON.stringify(out, null, 2),
    );
  } else if (K[a]) console.table([await run(a, process.argv[3])]);
  else {
    await post(a);
    console.log("sent", a);
  }
})();
