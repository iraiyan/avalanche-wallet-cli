# Avalanche Wallet CLI

## Installing dependencies

The repo is currently set up for local dev of ledgerjs.

```
$ git submodule update --recursive --init
$ nix-shell -p libusb1 pkgconfig yarn
[nix-shell:~]$ yarn setup
[nix-shell:~]$ yarn install
```

`yarn setup` is a script defined in package.json which links the packages we are using.

## Running

```
$ nix-shell -p nodejs
[nix-shell:~]$ ./cli.js
```
