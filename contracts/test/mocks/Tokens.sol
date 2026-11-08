// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Plain ERC-20 with a public mint, 6 decimals like USDC.
contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    uint8 public constant decimals = 6;
    string public constant symbol = "USDC";

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Returns nothing from transfer, like USDT.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

/// Returns false instead of reverting.
contract FalseToken {
    function balanceOf(address) external pure returns (uint256) {
        return type(uint128).max;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

interface IPayable {
    function pay(address to, uint256 amount, string calldata memo) external;
}

interface IReceiver {
    function onTokenReceived(uint256 amount) external;
}

/// Calls the recipient during a transfer, as a token with hooks (ERC-777 style) would.
contract HookToken is MockUSDC {
    function transfer(address to, uint256 amount) external override returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        if (to.code.length > 0) IReceiver(to).onTokenReceived(amount);
        return true;
    }
}

/// A compromised agent that is also the recipient: every payment it receives triggers
/// another payment to itself, trying to slip past the caps mid-transfer.
contract ReentrantAgent is IReceiver {
    IPayable public vault;
    uint256 public reentries;

    function setVault(IPayable vault_) external {
        vault = vault_;
    }

    function start(uint256 amount) external {
        vault.pay(address(this), amount, "first");
    }

    function onTokenReceived(uint256 amount) external {
        if (reentries >= 10) return;
        reentries++;
        try vault.pay(address(this), amount, "again") {} catch {}
    }
}
