import {
  Address,
  Assets,
  Blockfrost,
  Data,
  Constr,
  Credential,
  Script,
  ScriptHash,
  PolicyId,
  Emulator,
  fromText,
  generatePrivateKey,
  paymentCredentialOf,
  getAddressDetails,
  OutRef,
  Lucid,
  toUnit,
  TxHash,
  C,
  Utils,
  fromHex,
  toHex,
  concat,
  toPublicKey,
  UTxO,
  PROTOCOL_PARAMETERS_DEFAULT,
  Provider,
} from "../../lucid/mod.ts";
import * as cbor from "https://deno.land/x/cbor@v1.4.1/index.js";
import { Args, parse } from "https://deno.land/std@0.184.0/flags/mod.ts";
import { ABL, Coin, SwapFees, doSwap, doDeposit, doWithdrawal } from "./cpp.ts";
import * as random from "https://deno.land/x/random@v1.1.2/Random.js";
import * as types from "./types.ts";
import { sleep } from "https://deno.land/x/sleep/mod.ts";

const rand = new random.Random();

let bootUtxoHash = "ebcee8dcdbd7312f5e04a0033472465003617abe9935a6e56f007961897cfabb";
let bootUtxoIx = 1;

function settingsDatum(poolHash: string, poolStakeHash: string, userPkh: string): string {
  let nobody = "00000000000000000000000000000000000000000000000000000000";
  const datum: types.SettingsDatum = {
    poolScriptHash: poolHash,
    settingsAdmin: {
      signature: userPkh,
    },
    metadataAdmin: {
      paymentCredential: {
        VKeyCredential: { bytes: userPkh },
      },
      stakeCredential: null,
    },
    treasuryAdmin: {
      signature: userPkh,
    },
    treasuryAddress: {
      paymentCredential: {
        VKeyCredential: { bytes: userPkh },
      },
      stakeCredential: null,
    },
    treasuryAllowance: [1n, 10n],
    authorizedScoopers: [
      userPkh,
    ],
    authorizedStakingKeys: [
      poolStakeHash,
    ],
    baseFee: 1000000n,
    simpleFee: 100000n,
    strategyFee: 200000n,
    extensions: 0n,
  };
  return Data.to(datum, types.SettingsDatum);
}

function settingsMintRedeemer() { return "d87980" };

async function bootSettings(lucid: Lucid, scripts: Scripts, userPkh: string, inputs?: UTxO[]): Promise<TxHash> {
  const newSettingsDatum = settingsDatum(scripts.poolScriptHash, scripts.poolStakeHash, userPkh);
  const tx = await lucid.newTx()
    .collectFrom(inputs)
    .mintAssets({
      [toUnit(scripts.settingsPolicyId, fromText("settings"))]: 1n,
    }, settingsMintRedeemer())
    .attachMintingPolicy(scripts.settingsMint)
    .collectFrom(inputs || [])
    .payToContract(scripts.settingsAddress, { inline: newSettingsDatum }, {
      "lovelace": 2_000_000n,
      [toUnit(scripts.settingsPolicyId, fromText("settings"))]: 1n,
    })
    .complete({
      coinSelection: false,
    });
  const signedTx = await tx.sign().complete();
  return signedTx.submit();
}

async function listOrder(lucid: Lucid, scripts: Scripts, userPkh: string, assets: CoinPair, gives: bigint, scooperFee: bigint, changeUtxos: UTxO[], count: bigint, targetPoolId?: string): Promise<TxHash> {
  const rider = 2_000_000n;
  const tx = lucid.newTx();
  tx.collectFrom(changeUtxos);
  for (let i = 0n; i < count; i++) {
    let flip = flags.random && rand.pick(true, false);
    if (flip) {
      let [tmpPolicyId, tmpTokenName] = assets[0];
      assets[0][0] = assets[1][0];
      assets[0][1] = assets[1][1];
      assets[1][0] = tmpPolicyId;
      assets[1][1] = tmpTokenName;
    }
    const newOrderDatum: types.OrderDatum = {
      poolIdent: targetPoolId,
      owner: {
        signature: userPkh,
      },
      scooperFee: scooperFee,
      destination: {
        address: {
          paymentCredential: {
            VKeyCredential: { bytes: userPkh },
          },
          stakeCredential: null,
        },
        datum: "NoDatum",
      },
      order: {
        Swap: {
          offer: [assets[0][0], assets[0][1], gives],
          minReceived: [assets[1][0], assets[1][1], 0n],
        },
      },
      extension: "NoExtension",
    };
    let value = {
      "lovelace": rider + scooperFee,
    };
    if (assets[0][0] == "") {
      value["lovelace"] += gives;
    } else {
      value[assets[0][0] + assets[0][1]] = gives;
    }
    console.log("value out: ");
    console.log(value);
    tx.payToContract(scripts.orderAddress, { inline: Data.to(newOrderDatum, types.OrderDatum) }, value);
  }
  const completed = await tx.complete({
    coinSelection: false,
  });
  const signedTx = await completed.sign().complete();
  const signedStr = await signedTx.toString();
  console.log("signed tx for listOrder: " + signedStr);
  //throw new Error("florp");
  return signedTx.submit();
}

async function cancelOrder(lucid: Lucid, scripts: Scripts, userAddress: string, userPkh: string, orderUtxo: UTxO, changeUtxo: UTxO): Promise<TxHash> {
  const rider = 2_000_000n;
  const tx = lucid.newTx();
  tx.collectFrom([changeUtxo]);
  console.log("Cancel redeemer: ");
  console.log(Data.to("Cancel", types.OrderRedeemer));
  tx.collectFrom([orderUtxo], Data.to("Cancel", types.OrderRedeemer));
  tx.attachSpendingValidator(scripts.orderValidator);
  tx.addSigner(userAddress);
  const completed = await tx.complete({
    coinSelection: false,
  });
  const signedTx = await completed.sign().complete();
  return signedTx.submit();
}

function fakeAddress(lucid: Lucid): [Address, C.Ed25519KeyHash, string] {
  const userPrivateKey = "ed25519_sk1zxsfsl8ehspny4750jeydt5she7dzstrj7za5vgxl6929kr9d33quqkgp3";
  const userPublicKey = toPublicKey(userPrivateKey);
  const userPkh = C.PublicKey.from_bech32(userPublicKey).hash();
  const userAddress = (new Utils(lucid)).credentialToAddress({
    type: "Key",
    hash: userPkh.to_hex(),
  });
  return [userAddress, userPkh, userPrivateKey];
}
interface Scripts {
  poolValidator: Script;
  poolScriptHash: ScriptHash;
  poolAddress: Address;
  settingsValidator: Script;
  settingsScriptHash: ScriptHash;
  settingsAddress: Address;
  orderValidator: Script;
  orderScriptHash: ScriptHash;
  orderAddress: Address;
  steakValidator: Script;
  steakScriptHash: ScriptHash;
  steakAddress: Address;
  poolMint: Script;
  poolPolicyId: PolicyId;
  poolStakeHash: ScriptHash;
  poolStakeAddress: Address;
};

function bytesToScript(bytes: string) {
  return { type: "PlutusV2", script: bytes };
}

function getScriptsAiken(lucid: Lucid, json: any): Scripts {
  let validator = json["validators"];
  let out: any = {};
  for (let v of validator) {
    if (v.title == "order.spend") {
      out.orderValidator = bytesToScript(v.compiledCode);
      out.orderScriptHash = lucid.utils.validatorToScriptHash(out.orderValidator);
      out.orderAddress = lucid.utils.validatorToAddress(out.orderValidator);
    }
    if (v.title == "settings.spend") {
      out.settingsValidator = bytesToScript(v.compiledCode);
      out.settingsScriptHash = lucid.utils.validatorToScriptHash(out.settingsValidator);
      out.settingsAddress = lucid.utils.validatorToAddress(out.settingsValidator);
    }
    if (v.title == "pool.spend") {
      out.poolValidator = bytesToScript(v.compiledCode);
      out.poolScriptHash = lucid.utils.validatorToScriptHash(out.poolValidator);
      out.poolAddress = lucid.utils.validatorToAddress(out.poolValidator);
    }
    if (v.title == "stake.stake") {
      out.steakValidator = bytesToScript(v.compiledCode);
      out.steakScriptHash = lucid.utils.validatorToScriptHash(out.steakValidator);
      out.steakAddress = lucid.utils.validatorToRewardAddress(out.steakValidator);
    }
    if (v.title == "pool.mint") {
      out.poolMint = bytesToScript(v.compiledCode);
      out.poolPolicyId = lucid.utils.mintingPolicyToId(out.poolMint);
    }
    if (v.title == "settings.mint") {
      out.settingsMint = bytesToScript(v.compiledCode);
      out.settingsPolicyId = lucid.utils.mintingPolicyToId(out.settingsMint);
    }
    if (v.title == "pool_stake.stake") {
      out.poolStakeValidator = bytesToScript(v.compiledCode);
      out.poolStakeHash = lucid.utils.validatorToScriptHash(out.poolStakeValidator);
      out.poolStakeAddress = lucid.utils.validatorToRewardAddress(out.poolStakeValidator);
    }
  }
  return out;
}

async function testSettingsBoot(lucid: Lucid, emulator: Emulator, scripts: Scripts) {
  const dummy = await Lucid.new(undefined, "Custom");
  const [userAddress, userPkh, userPrivateKey] = fakeAddress(dummy);

  const bootUtxo = (await emulator.getUtxosByOutRef([{
    txHash: bootUtxoHash,
    outputIndex: bootUtxoIx,
  }]))[0];

  console.log(bootUtxo);

  lucid.selectWalletFromPrivateKey(userPrivateKey);
  const bootedHash = await bootSettings(lucid, scripts, userPkh.to_hex(), [bootUtxo]);
  console.log("bootedHash: " + bootedHash);
  await emulator.awaitTx(bootedHash);
  return bootedHash;
}

async function realSettingsBoot(scripts: Scripts, privateKeyFile: string) {
  const sk = await Deno.readTextFile(privateKeyFile);
  const skCborHex = JSON.parse(sk).cborHex;
  const skBech32 = C.PrivateKey.from_bytes(fromHex(skCborHex)).to_bech32();
  const userPublicKey = toPublicKey(skBech32);
  const userPkh = C.PublicKey.from_bech32(userPublicKey).hash();
  const userAddress = (new Utils(dummy)).credentialToAddress({
    type: "Key",
    hash: userPkh.to_hex(),
  });

  console.log("private key: " + skBech32);
  console.log("public key: " + userPublicKey);
  console.log("public key hash: " + userPkh.to_hex());
  console.log("address: " + userAddress);

  const blockfrost = new Blockfrost(flags.blockfrostUrl as string, flags.blockfrostProjectId as string);
  const lucid = await Lucid.new(blockfrost, "Preview");

  lucid.selectWalletFromPrivateKey(skBech32);

  let walletUtxos = await lucid.wallet.getUtxos();
  let toSpend = undefined;
  for (let utxo of walletUtxos) {
    if (utxo.txHash == bootUtxoHash && utxo.outputIndex == bootUtxoIx) {
      toSpend = utxo;
      break;
    }
  }

  if (toSpend == undefined) {
    throw new Error("the boot utxo was not found in the wallet");
  }

  const bootedHash = await bootSettings(lucid, scripts, userPkh.to_hex(), [toSpend]);
  console.log("bootedHash: " + bootedHash);
}

async function doCancelOrder(scripts: Scripts, privateKeyFile: string, order: string, change: string) {
  const sk = await Deno.readTextFile(privateKeyFile);
  const skCborHex = JSON.parse(sk).cborHex;
  const skBech32 = C.PrivateKey.from_bytes(fromHex(skCborHex)).to_bech32();
  const userPublicKey = toPublicKey(skBech32);
  const userPkh = C.PublicKey.from_bech32(userPublicKey).hash();
  const userAddress = (new Utils(dummy)).credentialToAddress({
    type: "Key",
    hash: userPkh.to_hex(),
  });

  console.log("private key: " + skBech32);
  console.log("public key: " + userPublicKey);
  console.log("public key hash: " + userPkh.to_hex());
  console.log("address: " + userAddress);

  const blockfrost = new Blockfrost(flags.blockfrostUrl as string, flags.blockfrostProjectId);
  const lucid = await Lucid.new(blockfrost, "Preview");

  lucid.selectWalletFromPrivateKey(skBech32);

  const [orderHash, orderIx] = order.split("#");
  const [orderUtxo] = await blockfrost.getUtxosByOutRef([{
    txHash: orderHash,
    outputIndex: Number(orderIx),
  }]);

  const [changeHash, changeIx] = change.split("#");
  const [changeUtxo] = await blockfrost.getUtxosByOutRef([{
    txHash: changeHash,
    outputIndex: Number(changeIx),
  }]);

  const canceledHash = await cancelOrder(
    lucid,
    scripts,
    userAddress,
    userPkh.to_hex(),
    orderUtxo,
    changeUtxo
  );
  console.log("canceledHash: " + canceledHash);
}

async function doListOrder(scripts: Scripts, privateKeyFile: string, coinA: string, coinB: string, change: string, poolIdent: string) {
  const sk = await Deno.readTextFile(privateKeyFile);
  const skCborHex = JSON.parse(sk).cborHex;
  const skBech32 = C.PrivateKey.from_bytes(fromHex(skCborHex)).to_bech32();
  const userPublicKey = toPublicKey(skBech32);
  const userPkh = C.PublicKey.from_bech32(userPublicKey).hash();
  const userAddress = (new Utils(dummy)).credentialToAddress({
    type: "Key",
    hash: userPkh.to_hex(),
  });

  console.log("private key: " + skBech32);
  console.log("public key: " + userPublicKey);
  console.log("public key hash: " + userPkh.to_hex());
  console.log("address: " + userAddress);

  const blockfrost = new Blockfrost(flags.blockfrostUrl as string, flags.blockfrostProjectId);
  const lucid = await Lucid.new(blockfrost, "Preview");

  lucid.selectWalletFromPrivateKey(skBech32);

  let changeRefs = [];
  for (let changeRef of change.split(",")) {
    const [changeHash, changeIx] = changeRef.split("#");
    changeRefs.push({
      txHash: changeHash,
      outputIndex: Number(changeIx),
    });
  }
  const changeUtxos = await blockfrost.getUtxosByOutRef(changeRefs);

  let assets: CoinPair = [
    assetFromString(coinA),
    assetFromString(coinB),
  ];

  let targetPoolId = null;
  if (poolIdent) {
    if (poolIdent.length == 56) {
      targetPoolId = poolIdent;
    } else {
      throw new Error("Malformed pool ident");
    }
  }

  const listedHash = await listOrder(
    lucid,
    scripts,
    userPkh.to_hex(),
    assets,
    BigInt(flags.gives),
    2_500_000n,
    changeUtxos,
    flags.count || 1n,
    targetPoolId
  );
  console.log("listedHash: " + listedHash);
}

function computePoolId(utxo: UTxO) {
  const poolInputTxHash = fromHex(utxo.txHash);
  const numberSign = new Uint8Array([0x23]);
  const poolInputTxIx = new Uint8Array([utxo.outputIndex]); // ident encoding for output index 1
  let poolInputRef = new Uint8Array([]);
  poolInputRef = concat(poolInputRef, poolInputTxHash);
  poolInputRef = concat(poolInputRef, numberSign);
  poolInputRef = concat(poolInputRef, poolInputTxIx);
  return C.hash_blake2b256(poolInputRef).slice(4); // Truncate first four bytes
}

function computePoolNftName(poolId: Uint8Array) {
  const prefix = new Uint8Array([0x00, 0x0d, 0xe1, 0x40]);
  return toHex(concat(prefix, poolId));
}

function computePoolLqName(poolId: Uint8Array) {
  const prefix = new Uint8Array([0x00, 0x14, 0xdf, 0x10]);
  return toHex(concat(prefix, poolId));
}

function computePoolRefName(poolId: Uint8Array) {
  const prefix = new Uint8Array([0x00, 0x06, 0x43, 0xb0]);
  return toHex(concat(prefix, poolId));
}

type Asset = [string, string];
type CoinPair = [Asset, Asset];

function isqrt(n: bigint): bigint {
  if (n < 0n) {
    throw new Error('isqrt: negative input');
  }

  if (n < 2n) {
    return n;
  }

  function go(m: bigint, x0: bigint): bigint {
    const x1 = ((m / x0) + x0) / 2n;
    if (x0 == x1 || x0 == (x1 - 1n)) {
      return x0;
    }
    return go(m, x1);
  }

  return go(n, 1n);
}

function initialLiquidity(coinA: bigint, coinB: bigint): bigint {
  return isqrt(coinA * coinB);
}

async function getRberryPolicyId(): Promise<[Script, string]> {
  const dummy = await Lucid.new(undefined, "Custom");
  const rberryMintingPolicy: Script = dummy.utils.nativeScriptFromJson({
    type: "all",
    scripts: [],
  });
  return [rberryMintingPolicy, dummy.utils.mintingPolicyToId(rberryMintingPolicy)];
}

async function postReferenceScript(scripts: Scripts, lucid: Lucid, userAddress: Address, scriptName: string, changeUtxo: UTxO, settings: UTxO): Promise<TxHash> {
  if (scriptName in scripts) {
    let signedTx;
    let retry = true;
    let nonce = 0n;
    while (retry) {
      const tx = await lucid.newTx()
        .collectFrom([changeUtxo])
        .payToAddressWithData(userAddress, {
          scriptRef: scripts[scriptName as keyof Scripts] as Script,
        }, {
          "lovelace": 2_000_000n,
        })
        .payToAddress(userAddress, { "lovelace": 2_000_000n + nonce })
        .complete({
          coinSelection: false,
        });
      signedTx = await tx.sign().complete();
      const hash = signedTx.toHash();
      if (hash > settings.txHash) {
        break;
      }
      nonce += 1n;
    }
    console.log("post reference script: ", signedTx.toString());
    return signedTx.submit();
  } else {
    throw new Error("script does not exist: " + scriptName);
  }
}

async function mintRberry(scripts: Scripts, lucid: Lucid, userAddress: Address): Promise<TxHash> {
  const [rberryMintingPolicy, rberryPolicyId]: [Script, string] = await getRberryPolicyId();
  const tx = await lucid.newTx()
    .mintAssets({
      [toUnit(rberryPolicyId, fromText("RBERRY"))]: 10_000_000_000n,
    })
    .attachMintingPolicy(rberryMintingPolicy)
    .payToAddress(userAddress, {
      "lovelace": 2_000_000n,
      [toUnit(rberryPolicyId, fromText("RBERRY"))]: 10_000_000_000n,
    })
    .complete();
  console.log("mintRberry: ", tx.toString());
  const signedTx = await tx.sign().complete();
  return signedTx.submit();
}

async function mintPool(scripts: Scripts, lucid: Lucid, userAddress: Address, settings: UTxO, references: UTxO[], assets: CoinPair, seed: UTxO, amountA: bigint, amountB: bigint, fees: bigint[], marketOpen?: bigint): Promise<TxHash> {
  const poolId = computePoolId(seed);
  const liq = initialLiquidity(amountA, amountB);
  const newPoolDatum: types.PoolDatum = {
    identifier: toHex(poolId),
    assets: assets,
    circulatingLp: liq,
    feesPer10Thousand: fees,
    marketOpen: marketOpen || 0n,
    feeFinalized: marketOpen || 0n,
    protocolFees: 2_000_000n,
  };
  const poolMintRedeemer: types.PoolMintRedeemer = {
    CreatePool: {
      assets: assets,
      poolOutput: 0n,
      metadataOutput: 2n,
    }
  };
  const poolNftNameHex = computePoolNftName(poolId);
  const poolLqNameHex = computePoolLqName(poolId);
  const poolRefNameHex = computePoolRefName(poolId);
  let poolValue = {
    [toUnit(scripts.poolPolicyId, poolNftNameHex)]: 1n,
    [toUnit(assets[1][0], assets[1][1])]: amountB,
  };
  if (assets[0][0] == "") {
    poolValue["lovelace"] = amountA + 2_000_000n;
  } else {
    poolValue[toUnit(assets[0][0], assets[0][1])] = amountA;
  }

  const poolMintRedeemerBytes = Data.to(poolMintRedeemer, types.PoolMintRedeemer);
  const poolDatumBytes = Data.to(newPoolDatum, types.PoolDatum);

  console.log("value: ");
  console.log(poolValue);
  console.log("newPoolDatum: ");
  console.log(poolDatumBytes);
  console.log("mint redeemer: ");
  console.log(poolMintRedeemerBytes);
  console.log("settings datum: ");
  console.log(settings.datum);
  console.log("-------");
  console.log("emulator.ledger", emulator.ledger);
  console.log("seed: ", seed);
  const tx = lucid.newTx()
    .mintAssets({
      [toUnit(scripts.poolPolicyId, poolNftNameHex)]: 1n,
      [toUnit(scripts.poolPolicyId, poolRefNameHex)]: 1n,
      [toUnit(scripts.poolPolicyId, poolLqNameHex)]: liq,
    }, poolMintRedeemerBytes)
    .readFrom([...references, settings])
    .collectFrom([seed])
    .payToContract(scripts.poolAddress, { inline: poolDatumBytes }, poolValue)
    .payToAddress(userAddress, {
      "lovelace": 2_000_000n,
      [toUnit(scripts.poolPolicyId, poolLqNameHex)]: liq,
    })
    .payToAddress(userAddress, {
      "lovelace": 2_000_000n,
      [toUnit(scripts.poolPolicyId, poolRefNameHex)]: 1n,
    });

  const str = await tx.toString();
  console.log("building tx: " + str);
  const completed = await tx.complete({
    coinSelection: false,
  });
  const signedTx = await completed.sign().complete();
  return signedTx.submit();
}

function assetFromString(s: string): Asset {
  if (s == "lovelace") {
    return ["", ""];
  }
  let chunks = s.split(".");
  if (chunks.length != 2) {
    throw new Error("Asset format is wrong: " + s);
  }
  return [chunks[0], chunks[1]];
}

//async function testMakePoolFunds(lucid: Lucid, emulator: Emulator, scripts: Scripts, coinA: string, coinAAmount: bigint, coinB: string, coinBAmount: bigint) {
//  const dummy = await Lucid.new(undefined, "Custom");
//  const [userAddress, userPkh, userPrivateKey] = fakeAddress(dummy);
//
//  const change = await findChange(emulator, userAddress);
//  let ok = false;
//  let nonce = 0n;
//  while (!ok) {
//    let tx = lucid.newTx()
//      .collectFrom([change]);
//    if (coinA == "lovelace") {
//      tx = tx.payToAddress(userAddress, {
//        [coinA]: coinAAmount + nonce,
//        [coinB]: coinBAmount,
//      });
//    } else {
//      tx = tx.payToAddress(userAddress, {
//        "lovelace": 2_000_000n + nonce,
//        [coinA]: coinAAmount,
//        [coinB]: coinBAmount,
//      });
//    }
//    const completed = await tx.complete({
//      coinSelection: false,
//    });
//    const hash = completed.toHash();
//    if (hash.startsWith('00')) {
//      ok = true;
//    }
//  }
//
//}

async function testMintPool(lucid: Lucid, emulator: Emulator, scripts: Scripts, coinA: string, coinB: string, refUtxo: UTxO, seed: UTxO) {
  const dummy = await Lucid.new(undefined, "Custom");
  const [userAddress, userPkh, userPrivateKey] = fakeAddress(dummy);

  let assets: CoinPair = [
    assetFromString(coinA),
    assetFromString(coinB),
  ];

  const settingsUtxos = await emulator.getUtxos(scripts.settingsAddress);

  if (settingsUtxos.length == 0) {
    throw new Error("Couldn't find any settings utxos: " + scripts.settingsAddress);
  }
  if (settingsUtxos.length > 1) {
    throw new Error("Multiple utxos at the settings address, I don't know which one to choose");
  }

  const settings = settingsUtxos[0];

  const mintedHash = await mintPool(scripts, lucid, userAddress, settings, [refUtxo], assets, seed, 1_000_000_000n, 1_000_000_000n, [5n, 5n]);
  console.log("Minted a pool, hash: " + mintedHash);
}

function computeIndexingSet(scripts: Scripts, changeUtxo: UTxO, targetPool: UTxO, orderUtxos: UTxO[]): bigint[] {
  let toSpend = [];
  toSpend.push(changeUtxo);
  toSpend.push(targetPool);
  toSpend.push(...orderUtxos);
  toSpend.sort((a, b) => a.txHash == b.txHash ? a.outputIndex - b.outputIndex : (a.txHash < b.txHash ? -1 : 1));
  let i = 0n;
  let indexingSet: bigint[] = [];
  for (let i = 0n; i < toSpend.length; i++) {
    let e = toSpend[Number(i)];
    if (e.address == scripts.orderAddress) {
      indexingSet.push(i);
    }
  }
  return indexingSet;
}

function getPoolABL(targetPool: UTxO, datum: types.PoolDatum): ABL {
  let poolCoinA = datum.assets[0][0] + datum.assets[0][1];
  let poolCoinB = datum.assets[1][0] + datum.assets[1][1];
  if (datum.assets[0][0] == "") {
    poolCoinA = "lovelace";
  }

  let poolAmountA = targetPool.assets[poolCoinA];
  if (poolCoinA == "lovelace") {
    poolAmountA -= datum.rewards;
  }

  let poolAmountB = targetPool.assets[poolCoinB];

  console.log("getPoolABL: poolAmountA: ");
  console.log(poolAmountA);

  const abl: ABL = {
    a: poolAmountA,
    b: poolAmountB,
    liq: datum.circulatingLp,
  };
  return abl;
}

type EscrowTakes = {
  abl: ABL,
  destination: Address,
};

async function fromOrderDatumAddress(addr: any): Promise<Address> {
  let paymentCred: Credential | null = null;
  if (addr.paymentCredential.VKeyCredential) {
    paymentCred = { type: "Key", hash: addr.paymentCredential.VKeyCredential.bytes };
  } else if (addr.paymentCredential.SCredential) {
    paymentCred = { type: "Script", hash: addr.paymentCredential.SCredential.bytes };
  } else {
    throw new Error("couldn't convert order datum address for lucid");
  }

  let stakingCred: Credential | null = null;
  if (addr.stakeCredential == null) {
    // That's ok 
  } else if (addr.stakeCredential.VKeyCredential) {
    stakingCred = { type: "Key", hash: addr.stakeCredential.VKeyCredential.bytes };
  } else if (addr.stakeCredential.SCredential) {
    stakingCred = { type: "Script", hash: addr.stakeCredential.SCredential.bytes };
  } else {
    throw new Error("couldn't convert order datum address for lucid: stake cred invalid");
  }
  console.log("debug: ");
  console.log(paymentCred);
  console.log(stakingCred);
  const dummy = await Lucid.new(undefined, "Custom");
  if (stakingCred) {
    return (new Utils(dummy)).credentialToAddress(paymentCred, stakingCred);
  } else {
    return (new Utils(dummy)).credentialToAddress(paymentCred);
  }
}

async function executeOrder(poolABL: ABL, poolDatum: types.PoolDatum, order: UTxO): Promise<[ABL, EscrowTakes]> {
  console.log("poolABL is: ");
  console.log(poolABL);
  let poolCoinA = poolDatum.assets[0][0] + poolDatum.assets[0][1];
  let poolCoinB = poolDatum.assets[1][0] + poolDatum.assets[1][1];
  if (!order.datum) {
    throw new Error("executeOrder: order utxo had no datum");
  }
  let orderDatum: types.OrderDatum = Data.from(order.datum, types.OrderDatum);
  let res: ABL = { a: 0n, b: 0n, liq: 0n };
  if ("Swap" in orderDatum.order) {
    if (orderDatum.order.Swap.offer[0] + orderDatum.order.Swap.offer[1] == poolCoinA) {
      [res, poolABL] = doSwap(Coin.CoinA, orderDatum.order.Swap.offer[2], poolDatum.feesPer10Thousand, poolABL);
      console.log("after swapping for coinA, poolABL will be: ");
      console.log(poolABL);
    } else if (orderDatum.order.Swap.offer[0] + orderDatum.order.Swap.offer[1] == poolCoinB) {
      [res, poolABL] = doSwap(Coin.CoinB, orderDatum.order.Swap.offer[2], poolDatum.feesPer10Thousand, poolABL);
    } else {
      throw new Error("Order does not appear to match the pool");
    }
  }
  const dest = await fromOrderDatumAddress(orderDatum.destination.address);
  return [poolABL, {
    abl: res,
    destination: dest,
  }];
}

async function updateABL(poolABL: ABL, poolDatum: types.PoolDatum, orders: UTxO[]): Promise<[ABL, EscrowTakes[]]> {
  orders.sort((a, b) => a.txHash == b.txHash ? a.outputIndex - b.outputIndex : (a.txHash < b.txHash ? -1 : 1));
  let takes: EscrowTakes[] = [];
  let currentPoolABL: ABL = {
    a: poolABL.a,
    b: poolABL.b,
    liq: poolABL.liq,
  };
  let take = null;
  for (let o of orders) {
    [currentPoolABL, take] = await executeOrder(currentPoolABL, poolDatum, o);
    takes.push(take);
  }
  return [currentPoolABL, takes];
}

async function scoopPool(scripts: Scripts, lucid: Lucid, userAddress: Address, settings: UTxO, orderUtxos: UTxO[], targetPool: UTxO, references: UTxO[], currentTime: number, changeUtxo: UTxO): Promise<TxHash> {
  console.log("settings: ");
  console.log(settings);
  const ordersCount: bigint = BigInt(orderUtxos.length);
  const rider = 2_000_000n;
  const indexingSet = computeIndexingSet(scripts, changeUtxo, targetPool, orderUtxos);
  console.log("indexingSet: ");
  console.log(indexingSet);
  const scoopPoolRedeemer: types.PoolRedeemer = {
    Spend: {
      contents: {
        signatoryIndex: 0n,
        scooperIndex: 29n,
        inputOrder: indexingSet,
      },
    },
  };
  const redeemerData = Data.to(scoopPoolRedeemer, types.PoolRedeemer);
  console.log("pool redeemer: ");
  console.log(redeemerData);
  const orderScoopRedeemer: types.OrderRedeemer = "Scoop";
  console.log("order redeemer: ");
  console.log(Data.to(orderScoopRedeemer, types.OrderRedeemer));
  if (!targetPool.datum) {
    throw new Error("Don't have a datum for the target pool.");
  }
  console.log("old pool datum: ");
  console.log(targetPool.datum);
  const poolDatum = Data.from(targetPool.datum, types.PoolDatum);
  const poolCoinA = poolDatum.assets[0][0] + poolDatum.assets[0][1];
  const poolCoinB = poolDatum.assets[1][0] + poolDatum.assets[1][1];
  console.log("pool coins: ", poolCoinA, poolCoinB);
  const poolABL = getPoolABL(targetPool, poolDatum);
  const [newPoolABL, escrowTakes] = await updateABL(poolABL, poolDatum, orderUtxos);
  console.log("newPoolABL: ");
  console.log(newPoolABL);
  let sumOfScooperFees = 0n;
  for (let e of orderUtxos) {
    let d = Data.from(e.datum, types.OrderDatum);
    sumOfScooperFees += d.scooperFee;
  }
  console.log(`sum of scooper fees: ${sumOfScooperFees}`);
  const mintedLiq = newPoolABL.liq - poolABL.liq;
  console.log("mintedLiq: ");
  console.log(mintedLiq);
  const oldRewards = poolDatum.rewards;
  poolDatum.rewards += sumOfScooperFees;
  poolDatum.circulatingLp = newPoolABL.liq;
  const poolNftNameHex = computePoolNftName(fromHex(poolDatum.identifier));
  const poolLqNameHex = computePoolLqName(fromHex(poolDatum.identifier));
  let tx = await lucid.newTx();
  let toSpend = [];
  toSpend.push(changeUtxo);
  toSpend.push(targetPool);
  toSpend.push(...orderUtxos);
  toSpend.sort((a, b) => a.txHash == b.txHash ? a.outputIndex - b.outputIndex : (a.txHash < b.txHash ? -1 : 1));
  for (let e of toSpend) {
    if (e.address == scripts.poolAddress) {
      tx.collectFrom([e], redeemerData);
    } else if (e.address == scripts.orderAddress) {
      tx.collectFrom([e], Data.to(orderScoopRedeemer, types.OrderRedeemer));
    } else {
      tx.collectFrom([e]);
    }
  }
  console.log("new pool datum: ");
  let newPoolDatum = Data.to(poolDatum, types.PoolDatum);
  console.log(newPoolDatum);
  console.log("references: ");
  console.log(references);
  console.log("current time: ");
  console.log(currentTime);
  tx
    .validFrom(currentTime - 1000000)
    .validTo(currentTime + 1000000)
    .readFrom([...references, settings])
    // Reference utxos should carry scriptRefs for these scripts
    // .attachSpendingValidator(scripts.orderValidator)
    // .attachSpendingValidator(scripts.poolValidator)
    .attachSpendingValidator(scripts.steakValidator)
    .addSigner(userAddress)
    .withdraw(scripts.steakAddress, 0n, "00")

    .payToContract(scripts.poolAddress, { inline: newPoolDatum }, {
      "lovelace":
        newPoolABL.a +
        sumOfScooperFees +
        oldRewards,
      [poolCoinB]: newPoolABL.b,
      [toUnit(scripts.poolPolicyId, poolNftNameHex)]: 1n,
    });

  if (mintedLiq != 0n) {
    tx.attachMintingPolicy(scripts.poolMint);
    const poolMintRedeemer: types.PoolMintRedeemer = {
      MintLP: {
        identifier: poolDatum.identifier,
      }
    };
    console.log("poolMintRedeemer: ");
    console.log(poolMintRedeemer);
    tx.mintAssets({
      [toUnit(scripts.poolPolicyId, poolLqNameHex)]: mintedLiq,
    }, Data.to(poolMintRedeemer, types.PoolMintRedeemer));
  }

  console.log("pool out datum: ");
  console.log(Data.to(poolDatum, types.PoolDatum));

  // We add the escrows to the order in reverse, because in the script, prepending to the list is cheaper
  for (let e of escrowTakes) {
    let valueOut: Assets = { "lovelace": rider + e.abl.a };
    if (e.abl.b > 0n) {
      valueOut[poolCoinB] = e.abl.b;
    }
    if (e.abl.liq > 0n) {
      valueOut[toUnit(scripts.poolPolicyId, poolLqNameHex)] = e.abl.liq;
    }
    console.log("valueOut: ");
    console.log(valueOut);
    tx.payToAddress(e.destination, valueOut);
  }
  const str = await tx.toString();
  console.log("building tx: " + str);
  const completed = await tx.complete({
    coinSelection: false, // We don't want extra inputs screwing up the indexing set
    nativeUplc: false, // "Lucid breaks with stake scripts"?
  });
  const signedTx = await completed.sign().complete();
  const signedStr = await signedTx.toString();
  console.log("signed tx: " + signedStr);
  return signedTx.submit();
}

// Conjure up utxos for the factory, pool, an order, and references, and put
// change in the user wallet
function populateLedgerForPool(scripts: Scripts, userAddress: Address, poolIdentHex: string, references: OutRef[], emulator: Emulator) {
  let userPkh = paymentCredentialOf(userAddress).hash as KeyHash;
  let rberryPolicy = "d441227553a0f1a965fee7d60a0f724b368dd1bddbc208730fccebcf";
  let rberryToken = "524245525259";
  let rberryAsset = rberryPolicy + rberryToken;
  let poolNftPolicy = scripts.poolScriptHash;
  let poolNftToken = "70" + poolIdentHex;
  let poolNftAsset = poolNftPolicy + poolNftToken;
  let settingsPolicy = scripts.settingsScriptHash;
  let settingsToken = "73657474696e6773";
  let settingsAsset = settingsPolicy + settingsToken;
  // References
  let i = 0n;
  for (let r of references) {
    let ref = null;
    if (i == 0n) {
      ref = scripts.poolValidator;
    } else if (i == 1n) {
      ref = scripts.orderValidator;
    } else {
      throw new Error("populateLedgerForPool: Too many references");
    }
    emulator.ledger[r.txHash + r.outputIndex] = {
      utxo: {
        txHash: r.txHash,
        outputIndex: r.outputIndex,
        assets: {
          "lovelace": 2_000_000n,
        },
        address: userAddress,
        datum: null,
        datumHash: null,
        scriptRef: ref,
      },
      spent: false,
    };
    i = i + 1n;
  }

  // Order
  let orderTxHash = "e45e735320366c49b0b195b4db35cb42534d05c8c241e84f745941689a90d66e";
  emulator.ledger[orderTxHash + "0"] = {
    utxo: {
      txHash: orderTxHash,
      outputIndex: 0,
      assets: {
        "lovelace": 12_500_000n,
      },
      address: scripts.orderAddress,
      datum: Data.to({
        owner: {
          signature: userPkh,
        },
        scooperFee: 2_500_000n,
        destination: {
          address: {
            paymentCredential: {
              VKeyCredential: { bytes: userPkh },
            },
            stakeCredential: null,
          },
          datum: "NoDatum",
        },
        order: {
          Swap: {
            offer: ["", "", 10_000_000n],
            minReceived: [rberryPolicy, rberryToken, 0n],
          },
        },
        extension: "NoExtension",
      }, types.OrderDatum),
      datumHash: null,
      scriptRef: null,
    },
    spent: false,
  };

  // Settings
  let settingsTxHash = "35e2d718baaff8e5c8c4c87d906661c6b142e5155b68cf40f7ff6c630d7c540a";
  emulator.ledger[settingsTxHash + "0"] = {
    utxo: {
      txHash: settingsTxHash,
      outputIndex: 0,
      assets: {
        "lovelace": 2_000_000n,
        [settingsAsset]: 1n,
      },
      address: scripts.settingsAddress,
      datum: Data.to({
        poolScriptHash: scripts.poolScriptHash,
        settingsAdmin: {
          signature: userPkh,
        },
        rewardsAdmin: {
          signature: userPkh,
        },
        authorizedScoopers: [
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          "00000000000000000000000000000000000000000000000000000000",
          userPkh,
        ],
        authorizedStakingKeys: [
        ],
      }, types.SettingsDatum),
      datumHash: null,
      scriptRef: null,
    },
    spent: false,
  };

  // Pool
  let poolTxHash = "294e2468f3aef27c83818df9476c10715cc417c687d4dc6a205d02419cd68ba7";
  emulator.ledger[poolTxHash + "0"] = {
    utxo: {
      txHash: poolTxHash,
      outputIndex: 0,
      address: scripts.poolAddress,
      assets: {
        "lovelace": 1_002_000_000n,
        [rberryAsset]: 1_000_000_000n,
        [poolNftAsset]: 1n,
      },
      datum: Data.to({
        identifier: poolIdentHex,
        assets: [
          ["", ""],
          [rberryPolicy, rberryToken],
        ],
        circulatingLp: 1_000_000_000n,
        feesPer10Thousand: 5n,
        marketOpen: 0n,
        rewards: 2_000_000n,
      }, types.PoolDatum),
      datumHash: null,
      scriptRef: null,
    },
    spent: false,
  };

  // User change
  let userChangeTxHash = "0000000000000000000000000000000000000000000000000000000000000004";
  emulator.ledger[userChangeTxHash + "0"] = {
    utxo: {
      txHash: userChangeTxHash,
      outputIndex: 0,
      address: userAddress,
      assets: {
        "lovelace": 100_000_000n,
      },
      datum: null,
      datumHash: null,
      scriptRef: null,
    },
    spent: false,
  };
  emulator.ledger[userChangeTxHash + "1"] = {
    utxo: {
      txHash: userChangeTxHash,
      outputIndex: 1,
      address: userAddress,
      assets: {
        "lovelace": 100_000_000n,
      },
      datum: null,
      datumHash: null,
      scriptRef: null,
    },
    spent: false,
  };
}

async function doScoopPool(scripts: Scripts, privateKeyFile: string, poolIdentHex: string, change: string, orders: any, references: string, fake: boolean) {
  const sk = await Deno.readTextFile(privateKeyFile);
  const skCborHex = JSON.parse(sk).cborHex;
  const skBech32 = C.PrivateKey.from_bytes(fromHex(skCborHex)).to_bech32();
  const userPublicKey = toPublicKey(skBech32);
  const userPkh = C.PublicKey.from_bech32(userPublicKey).hash();
  const userAddress = (new Utils(dummy)).credentialToAddress({
    type: "Key",
    hash: userPkh.to_hex(),
  });

  const refs = await Deno.readTextFile(references);
  const lines = refs.split(/\r?\n/);
  const refUtxosOutRefs: OutRef[] = [];
  for (let line of lines) {
    let [hash, ix] = line.split("#");
    let ixNum = Number(ix);
    if (hash == "" || isNaN(ixNum)) {
      continue;
    }
    refUtxosOutRefs.push({
      txHash: hash,
      outputIndex: Number(ix),
    });
  }

  let provider: Provider = null;
  let lucid: Lucid = null;
  let currentTime: number = 0;
  if (fake) {
    const emulator: Emulator = new Emulator([], {
      ...PROTOCOL_PARAMETERS_DEFAULT,
      maxTxSize: 999999999999,
      maxTxExMem: flags.findMax ? PROTOCOL_PARAMETERS_DEFAULT.maxTxExMem : 999999999999999n,
    });
    populateLedgerForPool(scripts, userAddress, poolIdentHex, refUtxosOutRefs, emulator);
    console.log("ledger: ");
    console.log(emulator.ledger);
    provider = emulator as Provider;
    lucid = await Lucid.new(provider, "Custom");
    console.log("Using emulator provider");
    currentTime = emulator.now();
  } else {
    const blockfrost: Blockfrost = new Blockfrost(
      flags.blockfrostUrl as string,
      flags.blockfrostProjectId
    );
    provider = blockfrost as Provider;
    lucid = await Lucid.new(provider, "Preview");
    currentTime = Date.now();
  }

  lucid.selectWalletFromPrivateKey(skBech32);

  const [changeHash, changeIx] = change.split("#");
  const [changeUtxo] = await provider.getUtxosByOutRef([{
    txHash: changeHash,
    outputIndex: Number(changeIx),
  }]);

  const refUtxos = await provider.getUtxosByOutRef(refUtxosOutRefs);

  let orderUtxos: UTxO[] = [];
  if (orders.mode == "auto") {
    orderUtxos = await provider.getUtxos(scripts.orderAddress);
  } else if (orders.mode == "manual") {
    let manualRefs = [];
    for (let ref of orders.orders) {
      let [hash, ix] = ref.split("#");
      manualRefs.push({
        txHash: hash,
        outputIndex: Number(ix),
      });
    }
    console.log("manualRefs: ");
    console.log(manualRefs);
    orderUtxos = await provider.getUtxosByOutRef(manualRefs);
  } else {
    throw new Error("Unknown order mode for pool scoop command: " + orders.mode);
  }

  orderUtxos = orderUtxos.slice(0, 25);

  console.log("orderUtxos: ");
  console.log(orderUtxos);
    
  let settingsUtxos = await provider.getUtxos(scripts.settingsAddress);
  if (settingsUtxos.length == 0) {
    throw new Error("Couldn't find any settings utxos: " + scripts.settingsAddress);
  }
  if (settingsUtxos.length > 1) {
    throw new Error("Multiple utxos at the settings address, I don't know which one to choose");
  }
  const settings = settingsUtxos[0];

  let knownPools = await provider.getUtxos(scripts.poolAddress);

  let targetPool = null;
  for (let knownPool of knownPools) {
    let targetAssetName = "70" + poolIdentHex;
    let targetPolicyId = scripts.poolScriptHash;
    let targetNftUnit = targetPolicyId + targetAssetName;
    let amountOfTargetNft = knownPool.assets[targetNftUnit];
    if (amountOfTargetNft == 1n) {
      targetPool = knownPool;
    } else if (amountOfTargetNft > 1n) {
      throw new Error("Impossible: Multiple copies of pool NFT found in UTXO: " + JSON.stringify(knownPool));
    }
  }
  if (targetPool == null) {
    throw new Error("Can't find a pool UTXO containing the NFT for the ident: " + poolIdentHex);
  }
  console.log("refUtxos: ");
  console.log(refUtxos);
  const scoopedHash = await scoopPool(scripts, lucid, userAddress, settings, orderUtxos, targetPool, refUtxos, currentTime, changeUtxo);
  console.log("Scooped pool, hash: " + scoopedHash);
}

async function doMintRberry(scripts: Scripts, privateKeyFile: string) {
  const sk = await Deno.readTextFile(privateKeyFile);
  const skCborHex = JSON.parse(sk).cborHex;
  const skBech32 = C.PrivateKey.from_bytes(fromHex(skCborHex)).to_bech32();
  const userPublicKey = toPublicKey(skBech32);
  const userPkh = C.PublicKey.from_bech32(userPublicKey).hash();
  const userAddress = (new Utils(dummy)).credentialToAddress({
    type: "Key",
    hash: userPkh.to_hex(),
  });

  const blockfrost = new Blockfrost(flags.blockfrostUrl as string, flags.blockfrostProjectId);
  const lucid = await Lucid.new(blockfrost, "Preview");

  lucid.selectWalletFromPrivateKey(skBech32);

  const mintedHash = await mintRberry(scripts, lucid, userAddress);
  console.log("Minted Rberry, hash: " + mintedHash);
}

async function testMintRberry(lucid: Lucid, emulator: Emulator, scripts: Scripts) {
  const dummy = await Lucid.new(undefined, "Custom");
  const [userAddress, userPkh, userPrivateKey] = fakeAddress(dummy);
  const mintedHash = await mintRberry(scripts, lucid, userAddress);
  await emulator.awaitTx(mintedHash);
  console.log("minted rberry, hash: " + mintedHash);
  const mintedUtxos = await emulator.getUtxosByOutRef([{
    txHash: mintedHash,
    outputIndex: 0,
  }]);
  return mintedUtxos[0];
}

async function fundUserAddress(lucid: Lucid, emulator: Emulator, scripts: Scripts) {
 // const dummy = await 
}

async function testPostReferenceScript(lucid: Lucid, emulator: Emulator, scripts: Scripts, scriptName: string) {
  const dummy = await Lucid.new(undefined, "Custom");
  const [userAddress, userPkh, userPrivateKey] = fakeAddress(dummy);
  const change = await findChange(emulator, userAddress);

  const settingsUtxos = await emulator.getUtxos(scripts.settingsAddress);

  if (settingsUtxos.length == 0) {
    throw new Error("Couldn't find any settings utxos: " + scripts.settingsAddress);
  }
  if (settingsUtxos.length > 1) {
    throw new Error("Multiple utxos at the settings address, I don't know which one to choose");
  }

  const settings = settingsUtxos[0];


  const postedHash = await postReferenceScript(scripts, lucid, userAddress, scriptName, change, settings);
  await emulator.awaitTx(postedHash);
  console.log("Posted reference script, hash: " + postedHash);
  const postedUtxos = await emulator.getUtxosByOutRef([{
    txHash: postedHash,
    outputIndex: 0,
  }]);
  return postedUtxos[0];
}


async function findChange(provider: Provider, userAddress: string): Promise<UTxO> {
  let startTime = Date.now();
  let changeUtxos = await provider.getUtxos(userAddress);
  let endTime = Date.now();
  console.log(`Fetched utxos from wallet, time elapsed: ${endTime - startTime}ms`);
  for (let changeUtxo of changeUtxos) {
    if (changeUtxo.datum != null && changeUtxo.datumHash != null) {
      continue;
    }
    if (changeUtxo.scriptRef != null) {
      continue;
    }
    if (changeUtxo.assets["lovelace"] >= 200_000_000n) {
      console.log("changeUtxo:");
      console.log(changeUtxo);
      return changeUtxo;
    }
  }
  throw new Error("findChange: Couldn't find a UTxO without a datum or script ref in the user wallet with over 200 ADA.");
}

async function findSettings(provider: Provider, settingsAddress: string, settingsPolicyId: string): Promise<UTxO> {
  let settingsUtxos = await provider.getUtxos(settingsAddress);
  for (let settingsUtxo of settingsUtxos) {
    // Verify that it's a real settings
    if (settingsUtxo.assets[settingsPolicyId + fromText("settings")] != 1n) {
      console.log(`settings utxo is missing the nft (${settingsPolicyId}${fromText("settings")}):`);
      console.log(settingsUtxo.assets);
      continue;
    }
    return settingsUtxo;
  }
  throw new Error("findSettings: Couldn't find a UTxO with the settings NFT at the settings address.");
}

async function findOrders(provider: Provider, orderAddress: string): Promise<UTxO[]> {
  let orderUtxos = await provider.getUtxos(orderAddress);
  let result: UTxO[] = [];
  for (let orderUtxo of orderUtxos) {
    let orderDatum: types.OrderDatum | null = null;
    try {
      orderDatum = Data.from(orderUtxo.datum as string, types.OrderDatum);
    } catch (e) {
      console.log("findOrders: UTxO at order address had invalid datum (skipping)");
      continue;
    }
    result.push(orderUtxo);
  }
  return result;
}

const flags = parse(Deno.args, {
  string: ["scriptsFile", "privateKey", "coinA", "coinB", "blockfrostUrl", "blockfrostProjectId"],
});
if (flags.scriptsFile == undefined) {
  throw "no scripts file";
}

let s = await Deno.readTextFile(flags.scriptsFile);
let scriptsJson = JSON.parse(s);
const dummy = await Lucid.new(undefined, "Custom");
const scripts = getScriptsAiken(dummy, scriptsJson);
const [userAddress, userPkh, userPrivateKey] = fakeAddress(dummy);

const accounts: any[] = [
  {
    address: userAddress,
    assets: {
      "lovelace": 1_000_000_000_000n,
    }
  }
];
let emulator = new Emulator(accounts);
let lucid = await Lucid.new(emulator);

emulator.ledger[bootUtxoHash + bootUtxoIx] = {
  utxo: {
    txHash: bootUtxoHash,
    outputIndex: bootUtxoIx,
    address: userAddress,
    assets: { lovelace: 1_000_000_000n },
    datumHash: undefined,
    datum: undefined,
    scriptRef: undefined
  },
  spent: false
};

await testSettingsBoot(lucid, emulator, scripts);
const mintedUtxo = await testMintRberry(lucid, emulator, scripts);
const poolMintRef = await testPostReferenceScript(lucid, emulator, scripts, "poolMint");
const [rberryMintingPolicy, rberryPolicyId]: [Script, string] = await getRberryPolicyId();
const rberry = rberryPolicyId + "." + fromText("RBERRY");
//await testMakePoolFunds(lucid, emulator, scripts, "lovelace", 1_020_000_000n, rberry, 1_000_000_000n);

emulator.ledger["00000000000000000000000000000000000000000000000000000000000000000"] = {
  utxo: {
    txHash: "0000000000000000000000000000000000000000000000000000000000000000",
    outputIndex: 0,
    assets: {
      lovelace: 100_000_000_000n,
      [toUnit(rberryPolicyId, fromText("RBERRY"))]: 100_000_000_000n,
    },
    address: userAddress,
    datumHash: undefined,
    datum: undefined,
    scriptRef: undefined
  },
  spent: false
};

const fakeChange = emulator.ledger["00000000000000000000000000000000000000000000000000000000000000000"].utxo;

await testMintPool(lucid, emulator, scripts, "lovelace", rberry, poolMintRef, fakeChange);
console.log(emulator.ledger);
