#!/usr/bin/env node

// Required by ledgerjs
require("babel-polyfill");

const HDKey = require('hdkey');
const createHash = require('create-hash');
const BN = require("bn.js");
const URI = require("urijs");
const commander = require("commander");
const AvaJS = require("avalanche");
const TransportNodeHid = require("@ledgerhq/hw-transport-node-hid").default;
const Ledger = require("@ledgerhq/hw-app-avalanche").default;

const BinTools = AvaJS.BinTools.getInstance();

const AVAX_ASSET_ID = "AVA"; // TODO changes to AVAX in next release
const AVAX_ASSET_ID_SERIALIZED = BinTools.b58ToBuffer("9xc4gcJYYg1zfLeeEFQDLx4HnCk81yUmV1DAUc6VfJFj"); // TODO is this correct? I got this from my account's UTXOSet. I have no idea how it is created.
const AVA_BIP32_PREFIX = "m/44'/9000'/"
const INDEX_RANGE = 20; // a gap of at least 20 indexes is needed to claim an index unused

// TODO replace this with something better
function log_error_and_exit(err) {
  console.error(err.message);
  process.exit(1);
}

// Convenience function to add the --device option
commander.Command.prototype.add_device_option = function() {
  return this.option("-d, --device <device>", "device to use");
}

// Convenience function to add the --node option
commander.Command.prototype.add_node_option = function() {
  return this.option("-n, --node <uri>", "node to use", "https://testapi.avax.network");
}

function ava_js_with_node(uri_string) {
  const uri = URI(uri_string);
  return new AvaJS.Avalanche(uri.hostname(), uri.port(), uri.protocol(), 3);
}

const program = new commander.Command();

program.version("0.0.1");

program
  .command("list-devices")
  .action(async () => {
  console.log(await TransportNodeHid.list());
});

program
  .command("get-device-model")
  .add_device_option()
  .action(async (options) => {
    const transport = await TransportNodeHid.open(options.device).catch(log_error_and_exit);
    console.log(transport.deviceModel);
});

program
  .command("get-wallet-id")
  .add_device_option()
  .action(async (options) => {
    const transport = await TransportNodeHid.open(options.device).catch(log_error_and_exit);
    const ledger = new Ledger(transport);
    const result = await ledger.getWalletId().catch(log_error_and_exit);
    console.log(result);
});

program
  .command("get-wallet-pubkey <path>")
  .description("get the public key of a derivation path. <path> should be 'account/change/address_index'")
  .add_device_option()
  .action(async (path, options) => {
    const transport = await TransportNodeHid.open(options.device).catch(log_error_and_exit);
    const ledger = new Ledger(transport);
    // BIP32: m / purpose' / coin_type' / account' / change / address_index
    path = AVA_BIP32_PREFIX + path
    console.log("Getting public key for path ", path);
    const result = await ledger.getWalletPublicKey(path).catch(log_error_and_exit);
    console.log(result);
    pubk = Buffer.from(result,'hex');
    KC = new AvaJS.AVMKeyPair();
    pubk_hash = KC.addressFromPublicKey(pubk);
    address = BinTools.avaSerialize(pubk_hash);
    console.log(address);
});

program
  .command("get-wallet-extpubkey <path>")
  .description("get the public key of a derivation path. <path> should be 'account/change/address_index'")
  .add_device_option()
  .action(async (path, options) => {
    const transport = await TransportNodeHid.open(options.device).catch(log_error_and_exit);
    const ledger = new Ledger(transport);
    // BIP32: m / purpose' / coin_type' / account' / change / address_index
    path = "m/44'/9000'/" + path
    console.log("Getting public key for path ", path);
    const result = await ledger.getWalletExtendedPublicKey(path).catch(log_error_and_exit);
    console.log(result);
});


program
  .command("get-balance <address>")
  .description("Get the AVAX balance of a particular address")
  .add_node_option()
  .action(async (address, options) => {
    const ava = ava_js_with_node(options.node);
    const avm = ava.AVM();
    let result = await avm.getBalance(address, AVAX_ASSET_ID).catch(log_error_and_exit);
    console.log(result.toString(10, 0));
});

async function get_extended_public_key(ledger, deriv_path) {
  extended_public_key = await ledger.getWalletExtendedPublicKey(deriv_path).catch(log_error_and_exit);
  hdw = new HDKey();
  hdw.publicKey = Buffer.from(extended_public_key.public_key,"hex");
  hdw.chainCode = extended_public_key.chain_code;
  return hdw
}

// Scan change addresses and find the first unused address (i.e. the first with no UTXOs)
// Adapted from wallet code.
// TODO this doesn't use the INDEX_RANGE thing, should it? Seems like it will reuse change addresses.
async function get_change_address(avm, root_key, log = false) {
  const change_key = root_key.deriveChild(1); // 1 = change

  var index = 0;
  var foundAddress = null;
  while (foundAddress === null) {
    const key = change_key.deriveChild(index);
    const address = hdkey_to_avax_address(key);
    const utxos = await avm.getUTXOs([address]).catch(log_error_and_exit);
    const is_unused = utxos.getAllUTXOs().length === 0;
    if (log) console.error("Index", index, address, is_unused ? "Unused" : "Used");
    if (is_unused) foundAddress = address;
    index++;
  }

  return foundAddress;
}

function hdkey_to_pkh(hdkey) {
  const KC = new AvaJS.AVMKeyPair();
  return KC.addressFromPublicKey(hdkey.publicKey);
}

function pkh_to_avax_address(pkh) {
  return "X-" + BinTools.avaSerialize(pkh);
}

// Convert a 'hdkey' (from the library of the same name) to an AVAX address.
function hdkey_to_avax_address(hdkey) {
  return pkh_to_avax_address(hdkey_to_pkh(hdkey));
}

// Given a hdkey (at the change or non-change level), sum the UTXO balances
// under that key.
async function sum_child_balances(avm, hdkey, log_prefix = null) {
  var balance = new BN(0);

  // getUTXOs is slow, so we generate INDEX_RANGE addresses at a time and batch them
  // Only when INDEX_RANGE accounts have no UTXOs do we assume we are done
  // TODO this loop is duplicated in prepare_for_transfer, dedupe it
  var index = 0;
  var all_unused = false;
  while (!all_unused) {
    var address_to_index = {}; // A dictionary from AVAX address to path index
    batch_addresses = [];
    batch_pkhs = [];
    for (var i = 0; i < INDEX_RANGE; i++) {
      const child = hdkey.deriveChild(index + i);
      const pkh = hdkey_to_pkh(child);
      batch_pkhs.push(pkh);
      const address = pkh_to_avax_address(pkh);
      batch_addresses.push(address);
      address_to_index[address] = index + i;
    }
    // Get UTXOs for this batch
    const batch_utxoset = await avm.getUTXOs(batch_addresses).catch(log_error_and_exit);
    // Total the balance for all PKHs
    const batch_balance = await batch_utxoset.getBalance(batch_pkhs, AVAX_ASSET_ID_SERIALIZED);

    for (const [pkh, utxoids] of Object.entries(batch_utxoset.addressUTXOs)) {
      var bal = new BN(0);
      for (const utxoid of Object.keys(utxoids)) {
        bal = bal.add(batch_utxoset.utxos[utxoid].getOutput().getAmount());
      }
      if (log_prefix !== null) {
        const addr = pkh_to_avax_address(Buffer.from(pkh, 'hex'));
        console.error(log_prefix + address_to_index[addr], addr, bal.toString());
      }
    };

    balance = balance.add(batch_balance);

    index = index + INDEX_RANGE;
    all_unused = batch_utxoset.getAllUTXOs().length === 0;
  }
  return balance;
}

// Given a hdkey (at the change or non-change level), get the full UTXO set for
// all addresses under that key. This also returns the addresses in path index
// order, and a dictionary for getting path index from UTXOID. This dictionary
// is used for determining which paths to sign via the ledger.
async function prepare_for_transfer(avm, hdkey) {
  // Return values
  var utxoset = new AvaJS.UTXOSet();
  var addresses = [];
  var utxoid_to_path_index = {}; // A dictionary from UTXOID to path index

  // getUTXOs is slow, so we generate INDEX_RANGE addresses at a time and batch them
  // Only when INDEX_RANGE accounts have no UTXOs do we assume we are done
  var index = 0;
  var all_unused = false;
  while (!all_unused) {
    var address_to_index = {}; // A dictionary from AVAX address to path index
    batch_addresses = [];
    batch_pkhs = [];
    for (var i = 0; i < INDEX_RANGE; i++) {
      const child = hdkey.deriveChild(index + i);
      const pkh = hdkey_to_pkh(child);
      batch_pkhs.push(pkh);
      const address = pkh_to_avax_address(pkh);
      batch_addresses.push(address);
      address_to_index[address] = index + i;
    }
    // Get UTXOs for this batch
    const batch_utxoset = await avm.getUTXOs(batch_addresses).catch(log_error_and_exit);

    // Update the UTXOID -> index dictionary
    // TODO does this need to be UTXOID -> [index], or does UTXOID -> index suffice?
    // i.e. are we clobbering existing indices?
    for (const [pkh, utxos] of Object.entries(batch_utxoset.addressUTXOs)) {
      const addr = pkh_to_avax_address(Buffer.from(pkh, 'hex'));
      for (const utxoid of Object.keys(utxos)) {
        utxoid_to_path_index[utxoid] = address_to_index[addr];
      }
    };

    utxoset = utxoset.union(batch_utxoset);
    addresses = addresses.concat(batch_addresses);

    index = index + INDEX_RANGE;
    all_unused = batch_utxoset.getAllUTXOs().length === 0;
  }
  return {
    set: utxoset,
    addresses: addresses,
    utxoid_to_path_index: utxoid_to_path_index,
  }
}

program
  .command("get-wallet-balance")
  .option("--accounts", "Display a breakdown for individual accounts")
  .description("Get the total balance of all accounts from this wallet")
  .add_node_option()
  .action(async options => {
    const ava = ava_js_with_node(options.node);
    const avm = ava.AVM();
    const transport = await TransportNodeHid.open(options.device).catch(log_error_and_exit);
    const ledger = new Ledger(transport);

    const root_key = await get_extended_public_key(ledger, "m/44'/9000'/0'");
    const change_balance = await sum_child_balances(avm, root_key.deriveChild(0), options.accounts ? "0/" : null);
    const non_change_balance = await sum_child_balances(avm, root_key.deriveChild(1), options.accounts ? "1/" : null);
    console.log(change_balance.add(non_change_balance).toString());
});

program
  .command("get-change-address")
  .description("Get the first unused change address")
  .add_node_option()
  .action(async options => {
    const avm = ava_js_with_node(options.node).AVM();
    const transport = await TransportNodeHid.open(options.device).catch(log_error_and_exit);
    const ledger = new Ledger(transport);
    const root_key = await get_extended_public_key(ledger, "m/44'/9000'/0'");
    let result = await get_change_address(avm, root_key, true);
    console.log(result);
});

program
  .command("get-utxos <address>")
  .add_node_option()
  .action(async (address, options) => {
    const ava = ava_js_with_node(options.node);
    const avm = ava.AVM();
    let result = await avm.getUTXOs([address]).catch(log_error_and_exit);
    console.log(result.getAllUTXOs());
});

/* Adapted from avm/tx.ts for class UnsignedTx */
async function sign_UnsignedTx(unsignedTx, utxo_id_to_path) {
  const txbuff = unsignedTx.toBuffer();
  const msg = Buffer.from(createHash('sha256').update(txbuff).digest());
  const baseTx = unsignedTx.transaction;
  const sigs = await sign_BaseTx(baseTx, msg, utxo_id_to_path);
  return new AvaJS.Tx(unsignedTx, sigs);
}

/* Adapted from avm/tx.ts for class BaseTx */
async function sign_BaseTx(baseTx, msg, utxo_id_to_path) {
  // TODO maybe these should be moved out and passed in
  const transport = await TransportNodeHid.open().catch(log_error_and_exit);
  const ledger = new Ledger(transport);

  const sigs = [];
  // For each tx input (sources of funds)
  for (let i = 0; i < baseTx.ins.length; i++) {
    const input = baseTx.ins[i];
    const cred = AvaJS.SelectCredentialClass(input.getInput().getCredentialID());
    const sigidxs = input.getInput().getSigIdxs();
    for (let j = 0; j < sigidxs.length; j++) {
      const path = utxo_id_to_path[input.getUTXOID()];
      const signval = await sign_with_ledger(ledger, msg, path);
      const sig = new AvaJS.Signature();
      sig.fromBuffer(Buffer.from(signval, "hex"));
      cred.addSignature(sig);
    }
    sigs.push(cred);
  }
  return sigs;
}

async function sign_with_ledger(ledger, hash, path) {
  // BIP44: m / purpose' / coin_type' / account' / change / address_index
  const full_path = AVA_BIP32_PREFIX + "0'/" + path;
  console.error("Signing hash", hash.toString('hex').toUpperCase(), "with path", full_path);
  console.error("Please verify on your ledger device");
  const result = await ledger.signHash(full_path, hash).catch(log_error_and_exit);
  const result2 = result.slice(64, -4);
  return result2;
}

function parse_amount(str) {
  try {
    return new BN(str);
  } catch (e) {
    console.error("Couldn't parse amount: ", e.message);
    console.error("Hint: Amount should be an integer, specified in nanoAVAX.");
    process.exit(1);
  }
}

program
  .command("transfer")
  .description("Transfer AVAX between accounts")
  .requiredOption("--amount <amount>", "Amount to transfer, specified in nanoAVAX")
  .requiredOption("--to <account>", "Recipient account")
  .add_node_option()
  .action(async options => {
    const avm = ava_js_with_node(options.node).AVM();
    const transport = await TransportNodeHid.open(options.device).catch(log_error_and_exit);
    const ledger = new Ledger(transport);

    const root_key = await get_extended_public_key(ledger, "m/44'/9000'/0'");

    console.error("Discovering accounts...");
    const non_change_utxos = await prepare_for_transfer(avm, root_key.deriveChild(0));
    const change_utxos = await prepare_for_transfer(avm, root_key.deriveChild(1));
    const all_utxos = non_change_utxos.set.union(change_utxos.set);

    // Build a dictionary from UTXOID to partial (change/index) path
    var utxo_id_to_path = {};
    for (const [utxoid, index] of Object.entries(change_utxos.utxoid_to_path_index)) {
      utxo_id_to_path[utxoid] = "1/" + index;
    }
    for (const [utxoid, index] of Object.entries(non_change_utxos.utxoid_to_path_index)) {
      utxo_id_to_path[utxoid] = "0/" + index;
    }

    const amount = parse_amount(options.amount);
    const toAddress = options.to;
    // We build the from addresses from all discovered change addresses,
    // followed by all discovered non-change addresses. This matches the web
    // wallet.
    // buildBaseTx will filter down to the minimum requirement in the order of
    // this array (and it is ordered by increasing path index).
    const fromAddresses = change_utxos.addresses.concat(non_change_utxos.addresses);

    console.error("Getting new change address...");
    // TODO don't loop again. get this from prepare_for_transfer for the change addresses
    const changeAddress = await get_change_address(avm, root_key);

    console.error("Building TX...");
    const unsignedTx = await
      avm.buildBaseTx(all_utxos, amount, [toAddress], fromAddresses, [changeAddress], AVAX_ASSET_ID_SERIALIZED)
      .catch(log_error_and_exit);
    const signed = await sign_UnsignedTx(unsignedTx, utxo_id_to_path);
    console.error("Issuing TX...");
    const txid = await avm.issueTx(signed);
    console.log(txid);
});

async function main() {
  await program.parseAsync(process.argv);
}

main();
