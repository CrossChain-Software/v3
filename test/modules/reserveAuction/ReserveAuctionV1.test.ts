import chai, { expect } from 'chai';
import asPromised from 'chai-as-promised';
import { ethers } from 'hardhat';
import {
  BadErc721,
  Erc20TransferHelper,
  Erc721TransferHelper,
  LibReserveAuctionV1Factory,
  ReserveAuctionV1,
  TestEip2981Erc721,
  TestErc721,
  Weth,
} from '../../../typechain';

import {
  approveNFTTransfer,
  bid,
  createReserveAuction,
  deployBadERC721,
  deployERC20TransferHelper,
  deployERC721TransferHelper,
  deployReserveAuctionV1,
  deployTestEIP2981ERC721,
  deployTestERC271,
  deployWETH,
  deployZoraModuleApprovalsManager,
  deployZoraProposalManager,
  deployZoraProtocol,
  endAuction,
  mintERC2981Token,
  mintERC721Token,
  mintZoraNFT,
  ONE_ETH,
  proposeModule,
  registerModule,
  revert,
  timeTravelToEndOfAuction,
  toRoundedNumber,
  TWO_ETH,
} from '../../utils';

import { BigNumber, Signer } from 'ethers';
import { Media } from '@zoralabs/core/dist/typechain';

chai.use(asPromised);

describe('ReserveAuctionV1', () => {
  let reserveAuction: ReserveAuctionV1;
  let zoraV1: Media;
  let badERC721: BadErc721;
  let testERC721: TestErc721;
  let testEIP2981ERC721: TestEip2981Erc721;
  let weth: Weth;
  let deployer: Signer;
  let curator: Signer;
  let bidderA: Signer;
  let bidderB: Signer;
  let fundsRecipient: Signer;
  let otherUser: Signer;
  let erc20TransferHelper: Erc20TransferHelper;
  let erc721TransferHelper: Erc721TransferHelper;

  beforeEach(async () => {
    await ethers.provider.send('hardhat_reset', []);
    const signers = await ethers.getSigners();
    deployer = signers[0];
    curator = signers[1];
    bidderA = signers[2];
    bidderB = signers[3];
    fundsRecipient = signers[4];
    otherUser = signers[5];
    const zoraProtocol = await deployZoraProtocol();
    zoraV1 = zoraProtocol.media;
    badERC721 = await deployBadERC721();
    testERC721 = await deployTestERC271();
    testEIP2981ERC721 = await deployTestEIP2981ERC721();
    weth = await deployWETH();
    const proposalManager = await deployZoraProposalManager(
      await deployer.getAddress()
    );
    const approvalManager = await deployZoraModuleApprovalsManager(
      proposalManager.address
    );
    erc20TransferHelper = await deployERC20TransferHelper(
      proposalManager.address,
      approvalManager.address
    );
    erc721TransferHelper = await deployERC721TransferHelper(
      proposalManager.address,
      approvalManager.address
    );
    reserveAuction = await deployReserveAuctionV1(
      erc20TransferHelper.address,
      erc721TransferHelper.address,
      zoraV1.address,
      weth.address
    );

    await proposeModule(proposalManager, reserveAuction.address);
    await registerModule(proposalManager, 1);

    await approvalManager.setApprovalForAllModules(true);
    await approvalManager.connect(bidderA).setApprovalForAllModules(true);
    await approvalManager.connect(bidderB).setApprovalForAllModules(true);
  });

  describe('#createAuction', () => {
    beforeEach(async () => {
      await mintZoraNFT(zoraV1);
      await approveNFTTransfer(zoraV1, erc721TransferHelper.address);
    });

    it('should revert if the 721 token does not support the ERC721 interface', async () => {
      const duration = 60 * 68 * 24;
      const reservePrice = BigNumber.from(10).pow(18).div(2);

      await expect(
        reserveAuction.createAuction(
          0,
          badERC721.address,
          duration,
          reservePrice,
          await curator.getAddress(),
          await fundsRecipient.getAddress(),
          5,
          ethers.constants.AddressZero
        )
      ).eventually.rejectedWith(
        revert`createAuction tokenContract does not support ERC721 interface`
      );
    });

    it('should revert if the token owner has not approved an auction', async () => {
      const duration = 60 * 68 * 24;
      const reservePrice = BigNumber.from(10).pow(18).div(2);
      const curatorFeePercentage = 15;
      const curator = ethers.constants.AddressZero;
      const fundsRecipientAddress = await fundsRecipient.getAddress();
      const auctionCurrency = ethers.constants.AddressZero;

      await expect(
        reserveAuction
          .connect(otherUser)
          .createAuction(
            0,
            zoraV1.address,
            duration,
            reservePrice,
            curator,
            fundsRecipientAddress,
            curatorFeePercentage,
            auctionCurrency
          )
      ).eventually.rejectedWith(
        revert`createAuction caller must be approved or owner for token id`
      );
    });

    it('should revert if the token ID does not exist', async () => {
      const duration = 60 * 68 * 24;
      const reservePrice = BigNumber.from(10).pow(18).div(2);
      const curatorFeePercentage = 15;
      const curator = ethers.constants.AddressZero;
      const fundsRecipientAddress = await fundsRecipient.getAddress();
      const auctionCurrency = ethers.constants.AddressZero;

      await expect(
        reserveAuction.createAuction(
          888,
          zoraV1.address,
          duration,
          reservePrice,
          curator,
          fundsRecipientAddress,
          curatorFeePercentage,
          auctionCurrency
        )
      ).eventually.rejectedWith('ERC721: approved query for nonexistent token');
    });

    it('should revert if the curator fee percentage is >= 100', async () => {
      const duration = 60 * 68 * 24;
      const reservePrice = BigNumber.from(10).pow(18).div(2);
      const curatorFeePercentage = 100;
      const curator = ethers.constants.AddressZero;
      const fundsRecipientAddress = await fundsRecipient.getAddress();
      const auctionCurrency = ethers.constants.AddressZero;

      await expect(
        reserveAuction.createAuction(
          0,
          zoraV1.address,
          duration,
          reservePrice,
          curator,
          fundsRecipientAddress,
          curatorFeePercentage,
          auctionCurrency
        )
      ).eventually.rejectedWith(
        revert`createAuction curatorFeePercentage must be less than 100`
      );
    });

    it('should revert if the funds recipient is 0', async () => {
      const duration = 60 * 60 * 24;
      const reservePrice = BigNumber.from(10).pow(18).div(2);
      const curatorFeePercentage = 10;
      const curatorAddress = await curator.getAddress();
      const fundsRecipientAddress = ethers.constants.AddressZero;
      const auctionCurrency = ethers.constants.AddressZero;

      await expect(
        reserveAuction.createAuction(
          0,
          zoraV1.address,
          duration,
          reservePrice,
          curatorAddress,
          fundsRecipientAddress,
          curatorFeePercentage,
          auctionCurrency
        )
      ).eventually.rejectedWith(
        revert`createAuction fundsRecipient cannot be 0 address`
      );
    });

    it('should create an auction', async () => {
      const duration = 60 * 60 * 24;
      const reservePrice = BigNumber.from(10).pow(18).div(2);
      const curatorFeePercentage = 10;
      const curatorAddress = await curator.getAddress();
      const fundsRecipientAddress = await fundsRecipient.getAddress();
      const auctionCurrency = ethers.constants.AddressZero;

      await reserveAuction.createAuction(
        0,
        zoraV1.address,
        duration,
        reservePrice,
        curatorAddress,
        fundsRecipientAddress,
        curatorFeePercentage,
        auctionCurrency
      );

      const createdAuction = await reserveAuction.auctions(0);
      expect(createdAuction.duration.toNumber()).to.eq(duration);
      expect(createdAuction.reservePrice.toString()).to.eq(
        reservePrice.toString()
      );
      expect(createdAuction.curatorFeePercentage).to.eq(curatorFeePercentage);
      expect(createdAuction.curator).to.eq(curatorAddress);
      expect(createdAuction.fundsRecipient).to.eq(fundsRecipientAddress);
      expect(createdAuction.tokenOwner).to.eq(await deployer.getAddress());
      expect(createdAuction.approved).to.eq(false);
    });

    it('should be automatically approved if the auction creator is the curator', async () => {
      const duration = 60 * 60 * 24;
      const reservePrice = BigNumber.from(10).pow(18).div(2);
      const curatorFeePercentage = 10;
      const curatorAddress = await deployer.getAddress();
      const fundsRecipientAddress = await fundsRecipient.getAddress();
      const auctionCurrency = ethers.constants.AddressZero;

      await reserveAuction.createAuction(
        0,
        zoraV1.address,
        duration,
        reservePrice,
        curatorAddress,
        fundsRecipientAddress,
        curatorFeePercentage,
        auctionCurrency
      );
      const createdAuction = await reserveAuction.auctions(0);

      expect(createdAuction.approved).to.eq(true);
    });

    it('should be automatically approved if the curator is 0x0', async () => {
      const duration = 60 * 60 * 24;
      const reservePrice = BigNumber.from(10).pow(18).div(2);
      const curatorFeePercentage = 10;
      const curatorAddress = ethers.constants.AddressZero;
      const fundsRecipientAddress = await fundsRecipient.getAddress();
      const auctionCurrency = ethers.constants.AddressZero;

      await reserveAuction.createAuction(
        0,
        zoraV1.address,
        duration,
        reservePrice,
        curatorAddress,
        fundsRecipientAddress,
        curatorFeePercentage,
        auctionCurrency
      );
      const createdAuction = await reserveAuction.auctions(0);

      expect(createdAuction.approved).to.eq(true);
    });

    xit('should emit an AuctionCreated event', async () => {
      const duration = 60 * 60 * 24;
      const reservePrice = BigNumber.from(10).pow(18).div(2);
      const curatorFeePercentage = 10;
      const curatorAddress = await curator.getAddress();
      const fundsRecipientAddress = await fundsRecipient.getAddress();
      const auctionCurrency = ethers.constants.AddressZero;

      const block = await ethers.provider.getBlockNumber();
      await reserveAuction.createAuction(
        0,
        zoraV1.address,
        duration,
        reservePrice,
        curatorAddress,
        fundsRecipientAddress,
        curatorFeePercentage,
        auctionCurrency
      );

      const createdAuction = await reserveAuction.auctions(0);
      const events = await reserveAuction.queryFilter(
        new LibReserveAuctionV1Factory()
          .attach(reserveAuction.address)
          .filters.AuctionCreated(
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null
          ),
        block
      );

      expect(events.length).to.eq(1);
      const logDescription = reserveAuction.interface.parseLog(events[0]);
      expect(logDescription.name).to.eq('AuctionCreated');
      expect(logDescription.args.auctionId.toNumber()).to.eq(0);
      expect(logDescription.args.tokenId.toNumber()).to.eq(
        createdAuction.tokenId.toNumber()
      );
      expect(logDescription.args.tokenContract).to.eq(
        createdAuction.tokenContract
      );
      expect(logDescription.args.duration.toNumber()).to.eq(
        createdAuction.duration.toNumber()
      );
      expect(logDescription.args.reservePrice.toString()).to.eq(
        createdAuction.reservePrice.toString()
      );
      expect(logDescription.args.curator).to.eq(createdAuction.curator);
      expect(logDescription.args.fundsRecipient).to.eq(
        createdAuction.fundsRecipient
      );
      expect(logDescription.args.curatorFeePercentage).to.eq(
        createdAuction.curatorFeePercentage
      );
      expect(logDescription.args.auctionCurrency).to.eq(
        ethers.constants.AddressZero
      );
    });
  });

  describe('#setAuctionApproval', async () => {
    beforeEach(async () => {
      await mintZoraNFT(zoraV1);
      await approveNFTTransfer(zoraV1, erc721TransferHelper.address);
      await createReserveAuction(
        zoraV1,
        reserveAuction,
        await deployer.getAddress(),
        await curator.getAddress()
      );
    });

    it('should revert if the auction does not exist', async () => {
      await expect(
        reserveAuction.setAuctionApproval(11, true)
      ).eventually.rejectedWith(revert`auctionExists auction doesn't exist`);
    });

    it('should revert if not called by the curator', async () => {
      await expect(
        reserveAuction.connect(otherUser).setAuctionApproval(0, true)
      ).eventually.rejectedWith(
        revert`setAuctionApproval must be auction curator`
      );
    });

    it('should revert if the auction has already started', async () => {
      await reserveAuction.connect(curator).setAuctionApproval(0, true);
      await bid(reserveAuction, 0, ONE_ETH);

      await expect(
        reserveAuction.connect(curator).setAuctionApproval(0, false)
      ).eventually.rejectedWith(
        'setAuctionApproval auction has already started'
      );
    });

    it('should approve the auction', async () => {
      await reserveAuction.connect(curator).setAuctionApproval(0, true);
      const auction = await reserveAuction.auctions(0);

      expect(auction.approved).to.eq(true);
    });

    xit('should emit an AuctionApprovalUpdated event', async () => {
      const block = await ethers.provider.getBlockNumber();

      await reserveAuction.connect(curator).setAuctionApproval(0, true);

      const events = await reserveAuction.queryFilter(
        new LibReserveAuctionV1Factory()
          .attach(reserveAuction.address)
          .filters.AuctionApprovalUpdated(null, null, null, null),
        block
      );

      expect(events.length).to.eq(1);
      const logDescription = reserveAuction.interface.parseLog(events[0]);
      expect(logDescription.name).to.eq('AuctionApprovalUpdated');
      expect(logDescription.args.auctionId).to.eq(1);
      expect(logDescription.args.tokenId).to.eq(1);
      expect(logDescription.args.tokenConract).to.eq(zoraV1.address);
      expect(logDescription.args.approved).to.eq(true);
    });
  });

  describe('#setAuctionReservePrice', () => {
    beforeEach(async () => {
      await mintZoraNFT(zoraV1);
      await approveNFTTransfer(zoraV1, erc721TransferHelper.address);
      await createReserveAuction(
        zoraV1,
        reserveAuction,
        await deployer.getAddress(),
        ethers.constants.AddressZero
      );
    });

    it('should revert if the auction does not exist', async () => {
      await expect(
        reserveAuction.setAuctionReservePrice(111, 1)
      ).eventually.rejectedWith();
    });

    it('should revert if the caller is not the owner or curator', async () => {
      await expect(
        reserveAuction.connect(otherUser).setAuctionReservePrice(0, 1)
      ).eventually.rejectedWith(
        revert`setAuctionReservePrice must be auction curator or token owner`
      );
    });

    it('should revert if the auction has already started', async () => {
      await bid(reserveAuction, 0, ONE_ETH);
      await expect(
        reserveAuction.setAuctionReservePrice(0, 1)
      ).eventually.rejectedWith(
        revert`setAuctionReservePrice auction has already started`
      );
    });

    it('should set the reserve price for the auction', async () => {
      await reserveAuction.setAuctionReservePrice(0, ONE_ETH.mul(2));
      const auction = await reserveAuction.auctions(0);

      expect(auction.reservePrice.toString()).to.eq(ONE_ETH.mul(2).toString());
    });

    xit('should emit an AuctionReservePriceUpdated event', async () => {});
  });

  describe('#createBid', () => {
    beforeEach(async () => {
      await mintZoraNFT(zoraV1);
      await approveNFTTransfer(zoraV1, erc721TransferHelper.address);
      await createReserveAuction(
        zoraV1,
        reserveAuction,
        await deployer.getAddress(),
        ethers.constants.AddressZero,
        undefined
      );
    });

    it('should not allow a bid on an unapproved auction', async () => {
      await mintZoraNFT(zoraV1, 'asa');
      await approveNFTTransfer(zoraV1, erc721TransferHelper.address, '1');
      await createReserveAuction(
        zoraV1,
        reserveAuction,
        await deployer.getAddress(),
        await curator.getAddress(),
        undefined,
        1
      );

      await expect(reserveAuction.createBid(1, 1)).eventually.rejectedWith(
        revert`createBid auction must be approved by curator`
      );
    });

    it('should revert if the auction expired', async () => {
      await bid(reserveAuction.connect(bidderA), 0, ONE_ETH);
      await timeTravelToEndOfAuction(reserveAuction, 0, true);

      await expect(
        reserveAuction.connect(bidderB).createBid(0, ONE_ETH.mul(2))
      ).eventually.rejectedWith(revert`createBid auction expired`);
    });

    it('should revert if the bid does not meet the reserve price', async () => {
      await expect(
        reserveAuction.connect(bidderA).createBid(0, 1)
      ).eventually.rejectedWith(
        revert`createBid must send at least reservePrice`
      );
    });

    it('should revert if the bid is not greater than 10% more of the previous bid', async () => {
      await bid(reserveAuction.connect(bidderA), 0, ONE_ETH);
      await expect(
        reserveAuction.connect(bidderB).createBid(0, ONE_ETH.add(1))
      ).eventually.rejectedWith(
        revert`createBid must send more than the last bid by minBidIncrementPercentage amount`
      );
    });

    it('should revert if the bid is invalid on zora v1', async () => {
      await expect(
        reserveAuction.connect(bidderA).createBid(0, ONE_ETH.add(1))
      ).eventually.rejectedWith(
        revert`createBid bid invalid for share splitting`
      );
    });

    it('should set the starting time on the first bid', async () => {
      await bid(reserveAuction.connect(bidderA), 0, ONE_ETH);
      const auction = await reserveAuction.auctions(0);

      expect(auction.firstBidTime.toNumber()).to.not.eq(0);
    });

    it('should refund the previous bidder', async () => {
      const beforeBalance = await ethers.provider.getBalance(
        await bidderA.getAddress()
      );
      await bid(reserveAuction.connect(bidderA), 0, ONE_ETH);
      await bid(reserveAuction.connect(bidderB), 0, ONE_ETH.mul(2));

      const afterBalance = await ethers.provider.getBalance(
        await bidderA.getAddress()
      );

      expect(toRoundedNumber(afterBalance)).to.approximately(
        toRoundedNumber(beforeBalance),
        5
      );
    });

    it('should accept the transfer and set the bid details on the auction', async () => {
      await bid(reserveAuction.connect(bidderA), 0, ONE_ETH);

      const auction = await reserveAuction.auctions(0);

      expect(auction.firstBidTime.toNumber()).to.not.eq(0);
      expect(auction.amount.toString()).to.eq(ONE_ETH.toString());
      expect(auction.bidder).to.eq(await bidderA.getAddress());
      expect(
        (await ethers.provider.getBalance(reserveAuction.address)).toString()
      ).to.eq(ONE_ETH.toString());
    });

    it('should extend the auction if it is in its final moments', async () => {
      const oldDuration = (await reserveAuction.auctions(0)).duration;
      await bid(reserveAuction.connect(bidderA), 0, ONE_ETH);
      await timeTravelToEndOfAuction(reserveAuction, 0);
      await bid(reserveAuction.connect(bidderB), 0, TWO_ETH);
      const newDuration = (await reserveAuction.auctions(0)).duration;

      expect(newDuration.toNumber()).to.eq(
        oldDuration.toNumber() - 1 + 15 * 60
      );
    });

    xit('should emit an AuctionBid event', async () => {});

    xit('should emit an AuctionDurationExtended event', async () => {});
  });

  describe('#endAuction', async () => {
    beforeEach(async () => {
      await mintZoraNFT(zoraV1);
      await approveNFTTransfer(zoraV1, erc721TransferHelper.address);
      await createReserveAuction(
        zoraV1,
        reserveAuction,
        await fundsRecipient.getAddress(),
        await curator.getAddress(),
        undefined
      );
      await reserveAuction.connect(curator).setAuctionApproval(0, true);
      await bid(reserveAuction.connect(bidderA), 0, ONE_ETH);
    });

    it('should revert if the auction does not exist', async () => {
      await expect(reserveAuction.endAuction(1111)).eventually.rejectedWith(
        revert`auctionExists auction doesn't exist`
      );
    });

    it('should revert if the auction has not begun', async () => {
      await mintZoraNFT(zoraV1, 'enw');
      await approveNFTTransfer(zoraV1, erc721TransferHelper.address, '1');
      await createReserveAuction(
        zoraV1,
        reserveAuction,
        await deployer.getAddress(),
        ethers.constants.AddressZero,
        undefined,
        1
      );
      await expect(reserveAuction.endAuction(1)).eventually.rejectedWith(
        revert`endAuction auction hasn't begun`
      );
    });

    it('should revert if the auction has not completed', async () => {
      await mintZoraNFT(zoraV1, 'enwa');
      await approveNFTTransfer(zoraV1, erc721TransferHelper.address, '1');
      await createReserveAuction(
        zoraV1,
        reserveAuction,
        await deployer.getAddress(),
        ethers.constants.AddressZero,
        undefined,
        1
      );
      await bid(reserveAuction.connect(bidderA), 1, ONE_ETH);

      await expect(reserveAuction.endAuction(1)).eventually.rejectedWith(
        revert`endAuction auction hasn't completed`
      );
    });

    it('should handle a zora auction payout', async () => {
      await timeTravelToEndOfAuction(reserveAuction, 0, true);

      const beforeFundsRecipientBalance = await fundsRecipient.getBalance();
      const beforeCuratorBalance = await curator.getBalance();
      const beforeCreatorBalance = await deployer.getBalance();

      await endAuction(reserveAuction, 0);

      const afterFundsRecipientBalance = await fundsRecipient.getBalance();
      const afterCuratorBalance = await curator.getBalance();
      const afterCreatorBalance = await deployer.getBalance();
      const tokenOwner = await zoraV1.ownerOf(0);

      expect(
        afterFundsRecipientBalance.sub(beforeFundsRecipientBalance).toString()
      ).to.eq('807500000000000000');
      expect(afterCuratorBalance.sub(beforeCuratorBalance).toString()).to.eq(
        '42500000000000000'
      );
      expect(toRoundedNumber(afterCreatorBalance)).to.approximately(
        toRoundedNumber(beforeCreatorBalance),
        500
      );
      expect(tokenOwner).to.eq(await bidderA.getAddress());
    });

    it('should handle an eip2981 auction payout', async () => {
      await mintERC2981Token(testEIP2981ERC721, await deployer.getAddress());
      await approveNFTTransfer(
        // @ts-ignore
        testEIP2981ERC721,
        erc721TransferHelper.address,
        '0'
      );
      await createReserveAuction(
        testEIP2981ERC721,
        reserveAuction,
        await fundsRecipient.getAddress(),
        await curator.getAddress(),
        undefined,
        0
      );
      await reserveAuction.connect(curator).setAuctionApproval(1, true);
      await bid(reserveAuction.connect(bidderA), 1, ONE_ETH);
      await timeTravelToEndOfAuction(reserveAuction, 1, true);

      const beforeFundsRecipientBalance = await fundsRecipient.getBalance();
      const beforeCreatorBalance = await deployer.getBalance();
      const beforeCuratorBalance = await curator.getBalance();
      await endAuction(reserveAuction, 1);
      const afterFundsRecipientBalance = await fundsRecipient.getBalance();
      const afterCreatorBalance = await deployer.getBalance();
      const afterCuratorBalance = await curator.getBalance();

      const tokenOwner = await testEIP2981ERC721.ownerOf(0);

      expect(
        afterFundsRecipientBalance.sub(beforeFundsRecipientBalance).toString()
      ).to.eq('475000000000000000');
      expect(afterCuratorBalance.sub(beforeCuratorBalance).toString()).to.eq(
        '25000000000000000'
      );
      expect(toRoundedNumber(afterCreatorBalance)).to.approximately(
        toRoundedNumber(beforeCreatorBalance.add(ONE_ETH.div(2))),
        500
      );
      expect(tokenOwner).to.eq(await bidderA.getAddress());
    });

    it('should handle a vanilla erc721 auction payout', async () => {
      await mintERC721Token(testERC721, await deployer.getAddress());
      // @ts-ignore
      await approveNFTTransfer(testERC721, erc721TransferHelper.address);
      await createReserveAuction(
        testERC721,
        reserveAuction,
        await fundsRecipient.getAddress(),
        await curator.getAddress(),
        undefined,
        0
      );
      await reserveAuction.connect(curator).setAuctionApproval(1, true);
      await bid(reserveAuction.connect(bidderA), 1, ONE_ETH);
      await timeTravelToEndOfAuction(reserveAuction, 1, true);

      const beforeCreatorBalance = await ethers.provider.getBalance(
        await deployer.getAddress()
      );
      await endAuction(reserveAuction, 1);

      const fundsRecipientBalance = (
        await ethers.provider.getBalance(await fundsRecipient.getAddress())
      ).toString();
      const afterCreatorBalance = await ethers.provider.getBalance(
        await deployer.getAddress()
      );
      const curatorBalance = await ethers.provider.getBalance(
        await curator.getAddress()
      );
      const tokenOwner = await testERC721.ownerOf(0);

      expect(fundsRecipientBalance).to.eq('10000950000000000000000');
      expect(toRoundedNumber(curatorBalance)).to.approximately(
        toRoundedNumber(BigNumber.from('10000050000000000000000')),
        2
      );
      expect(tokenOwner).to.eq(await bidderA.getAddress());
    });

    it('should reset the auction if the bidder cannot receive NFTs', () => {});

    xit('should emit an AuctionEnded event', async () => {});
  });

  describe('#cancelAuction', () => {
    beforeEach(async () => {
      await mintZoraNFT(zoraV1);
      await approveNFTTransfer(zoraV1, erc721TransferHelper.address);
      await createReserveAuction(
        zoraV1,
        reserveAuction,
        await fundsRecipient.getAddress(),
        await curator.getAddress(),
        undefined
      );
      await reserveAuction.connect(curator).setAuctionApproval(0, true);
    });

    it('should revert if the auction does not exist', async () => {
      await expect(reserveAuction.cancelAuction(1111)).eventually.rejectedWith(
        revert`auctionExists auction doesn't exist`
      );
    });

    it('should revert if not called by the curator or creator', async () => {
      await expect(
        reserveAuction.connect(otherUser).cancelAuction(0)
      ).eventually.rejectedWith(
        revert`cancelAuction only callable by curator or auction creator`
      );
    });

    it('should revert if the auction has started', async () => {
      await bid(reserveAuction.connect(bidderA), 0, ONE_ETH);

      await expect(reserveAuction.cancelAuction(0)).eventually.rejectedWith(
        revert`cancelAuction auction already started`
      );
    });

    it('should cancel an auction and return the token to the creator', async () => {
      await reserveAuction.cancelAuction(0);

      const deletedAuction = await reserveAuction.auctions(0);

      expect(await zoraV1.ownerOf(0)).to.eq(await deployer.getAddress());
      expect(deletedAuction.tokenContract).to.eq(ethers.constants.AddressZero);
      expect(deletedAuction.tokenOwner).to.eq(ethers.constants.AddressZero);
    });

    xit('should emit an AuctionCanceled event', async () => {});
  });
});
