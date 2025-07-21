const { Decimal } = require("decimal.js");
const _BN = require("bn.js");

const SCALING_FACTOR = 1e18;

const decimal = x => new Decimal(x.toString());

const fp = x => bn(toFp(x));

const toFp = x => decimal(x).mul(SCALING_FACTOR);

const fromFp = x => decimal(x).div(SCALING_FACTOR);

const bn = x => {
  if (typeof x === "bigint") return x;
  const stringified = parseScientific(x.toString());
  const integer = stringified.split(".")[0];
  return BigInt(integer);
};

const negate = x => {
  // Ethers does not expose the .notn function from bn.js, so we must use it ourselves
  return bn(new _BN(bn(x).toString()).notn(256).toString());
};

const maxUint = e => 2n ** bn(e) - 1n;

const maxInt = e => 2n ** bn(e - 1) - 1n;

const minInt = e => 2n ** bn(e - 1) * -1n;

const pct = (x, pct) => bn(decimal(x).mul(decimal(pct)));

const max = (a, b) => {
  a = bn(a);
  b = bn(b);

  return a > b ? a : b;
};

const min = (a, b) => {
  a = bn(a);
  b = bn(b);

  return a < b ? a : b;
};

const bnSum = bnArr => {
  return bn(bnArr.reduce((prev, curr) => bn(prev) + bn(curr), 0));
};

const arrayAdd = (arrA, arrB) => arrA.map((a, i) => bn(a) + bn(arrB[i]));

const arrayFpMulDown = (arrA, arrB) => arrA.map((a, i) => fpMulDown(a, arrB[i]));

const arraySub = (arrA, arrB) => arrA.map((a, i) => bn(a) - bn(arrB[i]));

const fpMulDown = (a, b) => (bn(a) * bn(b)) / FP_SCALING_FACTOR;

const fpDivDown = (a, b) => (bn(a) * FP_SCALING_FACTOR) / bn(b);

const fpDivUp = (a, b) => fpMulDivUp(bn(a), FP_SCALING_FACTOR, bn(b));

const fpMulUp = (a, b) => fpMulDivUp(bn(a), bn(b), FP_SCALING_FACTOR);

const fpMulDivUp = (a, b, c) => {
  const product = a * b;
  return product === 0n ? 0n : (product - 1n) / c + 1n;
};

// ceil(x/y) == (x + y - 1) / y
const divCeil = (x, y) => (x + y - 1n) / y;

const FP_SCALING_FACTOR = bn(SCALING_FACTOR);
const FP_ZERO = fp(0);
const FP_ONE = fp(1);
const FP_100_PCT = fp(1);

function printGas(gas) {
  if (typeof gas !== "number") {
    gas = Number(gas);
  }

  return `${(gas / 1000).toFixed(1)}k`;
}

function scaleUp(n, scalingFactor) {
  if (scalingFactor == bn(1)) {
    return n;
  }

  return n * scalingFactor;
}

function scaleDown(n, scalingFactor) {
  if (scalingFactor == bn(1)) {
    return n;
  }

  return n / scalingFactor;
}

function parseScientific(num) {
  // If the number is not in scientific notation return it as it is
  if (!/\d+\.?\d*e[+-]*\d+/i.test(num)) return num;

  // Remove the sign
  const numberSign = Math.sign(Number(num));
  num = Math.abs(Number(num)).toString();

  // Parse into coefficient and exponent
  const [coefficient, exponent] = num.toLowerCase().split("e");
  let zeros = Math.abs(Number(exponent));
  const exponentSign = Math.sign(Number(exponent));
  const [integer, decimals] = (
    coefficient.indexOf(".") != -1 ? coefficient : `${coefficient}.`
  ).split(".");

  if (exponentSign === -1) {
    zeros -= integer.length;
    num =
      zeros < 0
        ? integer.slice(0, zeros) + "." + integer.slice(zeros) + decimals
        : "0." + "0".repeat(zeros) + integer + decimals;
  } else {
    if (decimals) zeros -= decimals.length;
    num =
      zeros < 0
        ? integer + decimals.slice(0, zeros) + "." + decimals.slice(zeros)
        : integer + decimals + "0".repeat(zeros);
  }

  return numberSign < 0 ? "-" + num : num;
}

function randomFromInterval(min, max) {
  // min and max included
  return Math.random() * (max - min) + min;
}

function isBn(n) {
  return typeof n === "bigint";
}

// Export all functions and constants
module.exports = {
  decimal,
  fp,
  toFp,
  fromFp,
  bn,
  negate,
  maxUint,
  maxInt,
  minInt,
  pct,
  max,
  min,
  bnSum,
  arrayAdd,
  arrayFpMulDown,
  arraySub,
  fpMulDown,
  fpDivDown,
  fpDivUp,
  fpMulUp,
  fpMulDivUp,
  divCeil,
  FP_SCALING_FACTOR,
  FP_ZERO,
  FP_ONE,
  FP_100_PCT,
  printGas,
  scaleUp,
  scaleDown,
  parseScientific,
  randomFromInterval,
  isBn
};
