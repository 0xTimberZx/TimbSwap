# Audit Checklist

Generated on: 2026-07-01

## Attacker's Mindset

General check items for main attack types.

### Reentrancy Attack

An attacker exploits a contract's logic to repeatedly call into a function before the previous invocation is complete, potentially draining funds.

#### 1. Is there a view function that can return a stale value during interactions?

**Category Path:** Attacker's Mindset → Reentrancy Attack

**Description:** Read-only reentrancy. The read-only reentrancy is a reentrancy scenario where a view function is reentered, which in most cases is unguarded as it does not modify the contract's state. However, if the state is inconsistent, wrong values could be reported. Other protocols relying on a return value can be tricked into reading the wrong state to perform unwanted actions.

**Remediation:** Extend the reentrancy guard to the view functions as well.

**References:**
- [https://medium.com/@zokyo.io/read-only-reentrancy-attacks-understanding-the-threat-to-your-smart-contracts-99444c0a7334](https://medium.com/@zokyo.io/read-only-reentrancy-attacks-understanding-the-threat-to-your-smart-contracts-99444c0a7334)
- [https://solodit.xyz/issues/m-03-read-only-reentrancy-is-possible-code4rena-angle-protocol-angle-protocol-invitational-git](https://solodit.xyz/issues/m-03-read-only-reentrancy-is-possible-code4rena-angle-protocol-angle-protocol-invitational-git)
- [https://solodit.xyz/issues/h-13-balancerpairoracle-can-be-manipulated-using-read-only-reentrancy-sherlock-none-blueberry-update-git](https://solodit.xyz/issues/h-13-balancerpairoracle-can-be-manipulated-using-read-only-reentrancy-sherlock-none-blueberry-update-git)

- [ ] **Status:** Not Checked
- [ ] **Finding:** N/A
- [ ] **Notes:** 

---

#### 2. Is there any state change after interaction to an external contract?

**Category Path:** Attacker's Mindset → Reentrancy Attack

**Description:** Untrusted external contract calls could callback leading to unexpected results such as multiple withdrawals or out-of-order events.

**Remediation:** Use check-effects-interactions pattern or reentrancy guards.

**References:**
- [https://www.geeksforgeeks.org/reentrancy-attack-in-smart-contracts/](https://www.geeksforgeeks.org/reentrancy-attack-in-smart-contracts/)
- [https://solodit.xyz/issues/m-09-malicious-royalty-recipient-can-steal-excess-eth-from-buy-orders-code4rena-caviar-caviar-private-pools-git](https://solodit.xyz/issues/m-09-malicious-royalty-recipient-can-steal-excess-eth-from-buy-orders-code4rena-caviar-caviar-private-pools-git)
- [https://solodit.xyz/issues/h-01-re-entrancy-in-settleauction-allow-stealing-all-funds-code4rena-kuiper-kuiper-contest-git](https://solodit.xyz/issues/h-01-re-entrancy-in-settleauction-allow-stealing-all-funds-code4rena-kuiper-kuiper-contest-git)

- [ ] **Status:** Not Checked
- [ ] **Finding:** N/A
- [ ] **Notes:** 

---

