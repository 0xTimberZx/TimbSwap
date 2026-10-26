#!/usr/bin/env python3
"""Fail a mainnet site build that would show testnet game rules.

The testnet and mainnet sites share one copy; a rule that differs on mainnet
is written as twin blocks, data-net="sepolia" and data-net="mainnet", and only
the current network's block is shown. A rule sentence left outside the twins
is shown on both networks, so a mainnet visitor reads the testnet rule.

This removes every data-net="sepolia" block from each page, then fails if
testnet-only rule wording remains in the visible text. Run by
`NET=mainnet sh scripts/build-site.sh`; standalone:

  python3 scripts/rules-lint.py <site dir>
  python3 scripts/rules-lint.py --self-test

When a beta rule changes (lapse split, extra-round price, TIMBS entry), update
FORBIDDEN with the old wording in the same change as the copy.
"""
import os
import sys
from html.parser import HTMLParser

# Testnet-only rule wording that must never reach a mainnet visitor.
FORBIDDEN = [
    "70% of an eth deposit",            # lapse split: the beta sends 100% to the pot
    "majority of its eth principal",    # litepaper wording of the same split
    "a timbs deposit goes to the treasury",
    "extra rounds are paid in timbs",   # beta extra rounds are free
    "or with timbs",                    # beta entry is ETH only
]

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "source", "track", "wbr"}


class MainnetText(HTMLParser):
    """Visible text with data-net="sepolia" subtrees, scripts and styles removed."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip = 0          # depth inside a skipped subtree
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in VOID:
            return
        if self.skip:
            self.skip += 1
        elif dict(attrs).get("data-net") == "sepolia" or tag in ("script", "style"):
            self.skip = 1

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)

    def text(self):
        return " ".join(" ".join(self.parts).split()).lower()


def lint_html(html):
    p = MainnetText()
    p.feed(html)
    t = p.text()
    return [f for f in FORBIDDEN if f in t]


def lint_dir(root):
    hits = []
    for d, _, files in os.walk(root):
        for f in files:
            if f.endswith(".html"):
                path = os.path.join(d, f)
                with open(path, encoding="utf-8") as fh:
                    for phrase in lint_html(fh.read()):
                        hits.append((os.path.relpath(path, root), phrase))
    return hits


def self_test():
    cases = [
        ('<p>lapses: <span data-net="sepolia">70% of an ETH deposit goes to the pot</span>'
         '<span data-net="mainnet">the whole deposit goes to the live pot.</span></p>', []),
        ("<p>lapses: 70% of an ETH deposit goes to the pot</p>", ["70% of an eth deposit"]),
        ('<li data-net="sepolia"><span>Extra rounds are <b>paid in TIMBS</b></span></li>', []),
        ("<p>Extra rounds are <b>paid in TIMBS</b> and are not refundable.</p>",
         ["extra rounds are paid in timbs"]),
        ('<div data-net="sepolia"><br><img src=x><p>or with TIMBS</p></div><p>ok</p>', []),
        ("<script>var s = 'or with TIMBS';</script>", []),
        ('<span data-net="mainnet">or with TIMBS</span>', ["or with timbs"]),
    ]
    ok = 0
    for html, want in cases:
        got = lint_html(html)
        good = got == want
        ok += good
        print(("ok   " if good else "FAIL ") + repr(html[:60]), got)
    print(f"{ok}/{len(cases)} passed")
    return ok == len(cases)


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(0 if self_test() else 1)
    if len(sys.argv) != 2:
        sys.exit("usage: rules-lint.py <site dir> | --self-test")
    hits = lint_dir(sys.argv[1])
    for page, phrase in hits:
        print(f"mainnet copy shows a testnet rule: {page}: \"{phrase}\"", file=sys.stderr)
    if hits:
        print("Wrap the sentence in data-net twins (sepolia / mainnet) or update FORBIDDEN.", file=sys.stderr)
        sys.exit(1)
    print("rules-lint: mainnet copy clean")
