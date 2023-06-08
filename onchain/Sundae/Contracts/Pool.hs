module Sundae.Contracts.Pool where

import qualified Prelude
import PlutusTx.Prelude
import PlutusTx.Sqrt
import PlutusTx.Numeric

import PlutusLedgerApi.V3
import PlutusLedgerApi.V1.Value
import PlutusLedgerApi.V2.Contexts (findOwnInput)

import qualified PlutusTx.AssocMap as Map
import PlutusTx.Ratio

import Sundae.Contracts.Common
import Sundae.Utilities

{-# inlineable sortOn #-}
sortOn :: Ord b => (a -> b) -> [a] -> [a]
sortOn f =
  map snd . sortBy (comparing fst) . map (\x -> let y = f x in {-y `seq`-} (y, x))

{-# inlineable comparing #-}
comparing :: (Ord a) => (b -> a) -> b -> b -> Ordering
comparing p x y = compare (p x) (p y)

data EscrowWithFee = EscrowWithFee
  { fee :: !Integer
  , escrow :: {-# UNPACK #-} !(EscrowDestination, EscrowAction)
  }

data OrderedEscrow = OrderedEscrow
  { index :: !Integer
  , escrowWithFee :: {-# UNPACK #-} !EscrowWithFee
  }

-- Pool contract
--  Holds community liquidity, brokers swaps via a market maker formula via aggregating many operations
--  Parameterized by:
--    FactoryBootCurrencySymbol, to identify scooper licenses
--    PoolCurrencySymbol, to identify the Pool NFT
--    ScooperFeeHolderScriptHash, to identify where scooper rewards should be paid
--  Uses Datum:
--    coins, identifier, issued liquidity, fee rate
--  Allows (via Redeemer):
--    PoolScoop - Take a bunch of aggregated orders and enact them all
--    PoolUpgrade - Move the liquidity into a new script, when blessed by a proposal token
--  Details:
--    The pool is here for one thing: executing escrowed operations at a price
--    dictated by the pool's asset amounts. Notably, we assume that all script
--    inputs other than the pool itself are escrow inputs, because it lets us
--    avoid a circular dependency.
--    If you want to scoop the pool, you need a license token. You can get that
--    from the factory contract, if you're authorized.  We have the scoop
--    redeemer tell us when the license was issued, because that helps us find
--    the token in the inputs.

{-# inlinable poolContract #-}
poolContract
  :: FactoryBootCurrencySymbol
  -> PoolCurrencySymbol
  -> EscrowScriptHash
  -> PoolDatum
  -> PoolRedeemer
  -> ScriptContext
  -> Bool
poolContract (FactoryBootCurrencySymbol fbcs) (PoolCurrencySymbol pcs) _
  (PoolDatum coins@(AB coinA coinB) poolIdent oldCirculatingLP swapFees marketOpenTime rewards) (PoolScoop scooperPkh order) ctx =
  let
    !init = ABL (valueOfAC oldValueSansRider coinA) (valueOfAC oldValueSansRider coinB) oldCirculatingLP
    !(ScoopResult cons newAmtA newAmtB newCirculatingLP) =
      doEscrows swapFees init
        (escrow . escrowWithFee <$> sortOn index (zipWith OrderedEscrow order escrows))
  in
    debug "must have escrows"
      (not $ null escrows) &&
    debug "valid range too large"
      (validRangeSize (txInfoValidRange txInfo) <= hourMillis) &&
    debug "constant datum fields were changed"
      ( poolOutputCoins == coins &&
        poolOutputIdent == poolIdent &&
        poolOutputSwapFees == swapFees &&
        poolOutputMarketOpenTime == marketOpenTime) &&
    debug "circulating LP is wrong"
      (poolOutputLP == newCirculatingLP) &&
    debug "new rewards is wrong"
      (poolOutputRewards >= rewards + minimumScooperFee) &&
    debug "extra outputs not spent"
      (all' mustSpendTo (mergeListByKey cons)) &&
    debug "issued amount does not match minted amount"
      ( if newCirculatingLP == oldCirculatingLP
        then null (flattenValue' (txInfoMint txInfo))
        else onlyHas (txInfoMint txInfo) pcs (computeLiquidityTokenName poolIdent) (== (newCirculatingLP - oldCirculatingLP))
      ) &&
    debug "pool output (excluding the rider) must contain exactly: coin a, coin b, an NFT"
      (hasLimitedNft 3 (toPoolNft pcs poolIdent) poolOutputFunds) &&
    debug "pool output does not include all expected liquidity"
      (valueOfAC poolOutputFunds coinA == newAmtA &&
        valueOfAC poolOutputFunds coinB == newAmtB) &&
    debug "must be a licensed scooper"
      (case factoryReferenceDatum of
        FactoryDatum _ _ _ scoopers -> elem scooperPkh scoopers) &&
    debug "no swaps allowed before marketOpenTime"
      ( if earliest < marketOpenTime
        then all nonSwap escrows
        else True
      )
  where
  !(PoolDatum !poolOutputCoins !poolOutputIdent !poolOutputLP !poolOutputSwapFees !poolOutputMarketOpenTime !poolOutputRewards) =
    case datumOf txInfo poolOutput of
      Just pool -> pool
      Nothing -> traceError "pool output must have a pool datum"
  nonSwap (EscrowWithFee fee (_, escrowAction)) =
    case escrowAction of
      EscrowSwap _ _ _ -> False
      _ -> True
  !(LowerBound (Finite earliest) _) = ivFrom (txInfoValidRange txInfo)
  !factoryReference = uniqueElement'
    [ o
    | o <- txInfoReferenceInputs txInfo
    , isFactory fbcs (txInInfoResolved o)
    ]
  !factoryReferenceDatum =
    case datumOf txInfo (txInInfoResolved factoryReference) of
      Just fac -> fac
      Nothing -> traceError "factory reference must have a factory datum"
  scooperNFTExists :: CurrencySymbol -> TokenName -> [TxInInfo] -> Bool
  scooperNFTExists _ _ [] = traceError "scooper token must exists in inputs"
  scooperNFTExists sym tn ((TxInInfo _ ot) : tl)
    | valueContains (txOutValue ot) sym tn = True
    | otherwise = scooperNFTExists sym tn tl
  UpperBound (Finite latest) _ = ivTo (txInfoValidRange txInfo)
  !ownInput = scriptInput ctx
  !poolOutput = uniqueElement'
    [ o
    | o <- txInfoOutputs txInfo
    , isScriptAddress o ownScriptHash
    ]
  !poolOutputValue = txOutValue poolOutput
  !poolOutputFunds = sansAda (poolOutputRewards + riderAmount) poolOutputValue
  mustSpendTo (EscrowDestination addr dh, val, count) =
    atLeastOneSpending addr dh val count (txInfoOutputs txInfo)
  atLeastOneSpending :: Address -> Maybe DatumHash -> ABL Integer -> Integer -> [TxOut] -> Bool
  atLeastOneSpending _ _ _ _ [] = False
  atLeastOneSpending addr dh val count ((o@TxOut{txOutAddress, txOutValue}) : tl)
    | eqAddrCredential txOutAddress addr
    , txOutDatumHash o == dh
      -- Since every escrow input has a rider, we require every output to have a rider as well
      -- By subtracting it off here, it ensures you're getting all the funds you're entitled to
      -- according to doEscrows
    , let !txOutSansRider = sansRider' count txOutValue
    , val $$ CoinA <= valueOfAC txOutSansRider coinA
    , val $$ CoinB <= valueOfAC txOutSansRider coinB
    , liquidity val <= valueOfAC txOutSansRider liquidityAssetClass = True
    | otherwise = atLeastOneSpending addr dh val count tl
  !txInfo = scriptContextTxInfo ctx
  liquidityAssetClass =
    AssetClass (pcs, computeLiquidityTokenName poolIdent)
  !totalScooperFee = foldl' (\a (EscrowWithFee f _) -> a + f) zero escrows
  !minimumScooperFee = max 0 (totalScooperFee - valueOf (txInfoFee txInfo) adaSymbol adaToken)
  !escrows =
    [ EscrowWithFee scoopFee (fromEscrowAddress ret, act)
     | TxInInfo {txInInfoResolved = txOut} <- txInfoInputs txInfo
     , let !escrowInValue = txOutValue txOut
     -- Escrows will usually come from the escrow script, but it's OK if they
     -- come from somewhere else as long as the datum is valid. Other scripts
     -- might be useful to provide other conditions for escrows, such as stop
     -- loss orders. So we treat anything that doesn't come from the pool script
     -- as an escrow.
     , not (isScriptAddress txOut ownScriptHash)
     , Just (EscrowDatum ident ret scoopFee act) <- [datumOf txInfo txOut]
     , scoopFee >= 0
     -- Coin B can never be ADA, because pool coin pairs are lexicographically
     -- ordered when we create a pool, so we only check A here
     -- NOTE: this enforces that the escrow *always* has at least 2 ada on the rider,
     -- meaning you can't under-spend your rider and get 2ADA back
     , valueOf (sansAmountA escrowInValue act) adaSymbol adaToken >= scoopFee + riderAmount
     , if ident == poolIdent && checkAction escrowInValue act
       then True
       else die "escrow incorrect"
     ]
  oldValue = txOutValue ownInput
  ownScriptHash =
    case ownInput of
      (TxOut (Address (ScriptCredential h) _) _ _ _) -> h
      _ -> traceError "invalid pool script utxo"
  amountA = \case
    EscrowDeposit (DepositMixed (AB amtA _)) -> amtA
    EscrowDeposit (DepositSingle CoinA amt) -> amt
    EscrowDeposit (DepositSingle CoinB _) -> 0
    EscrowWithdraw _ -> 0
    EscrowSwap CoinA amt _ -> amt
    EscrowSwap CoinB _ _ -> 0
  sansAmountA v act =
    let
      AssetClass (coinASymbol, coinAToken) = coinA
      coinAValue = valueOfAC v coinA
    in
      Value $ Map.insert
        coinASymbol
        (Map.singleton coinAToken (coinAValue - amountA act))
        (getValue v)
  -- Subtract off the ADA rider;
  -- If we don't do this, ADA/X pools, this can screw up the price calculation
  -- Normally, the amount of ada in the pool should be able to asymptotically approach 0 as the price of ADA goes up
  -- With the added rider, it asymptotically approaches 2; if we don't subtract off the rider, then
  -- There might be a hard limit on how much the pool can be traded
  !oldValueSansRider = sansAda (rewards + riderAmount) oldValue
  checkAction !(sansRider -> v) = \case
    EscrowDeposit (DepositMixed (AB amtA amtB)) ->
      valueOfAC v coinA >= amtA && valueOfAC v coinB >= amtB && amtA >= 1 && amtB >= 1
    EscrowDeposit (DepositSingle coin amt) ->
      valueOfAC v (coins $$ coin) >= amt && amt >= 1
    EscrowWithdraw amt ->
      valueOfAC v liquidityAssetClass >= amt && amt >= 1
    EscrowSwap coin amt _ ->
      valueOfAC v (coins $$ coin) >= amt && amt >= 1

poolContract
  (FactoryBootCurrencySymbol fbcs) _ (EscrowScriptHash esh)
  _ PoolUpgrade ctx =
  debug "dead factory not included; must included dead factory to prove that the upgrade should be adopted"
    (atLeastOne (\i ->
      valueContains (txOutValue $ txInInfoResolved i) fbcs factoryToken &&
        case datumOf txInfo (txInInfoResolved i) of
          Just (DeadFactoryDatum {}) -> True
          _ -> False
      ) (txInfoInputs txInfo)) &&
  debug "must not spend escrows when upgrading pool"
    (not (atLeastOne (\i ->
      (txOutAddress $ txInInfoResolved i) == scriptHashAddress esh)
      (txInfoInputs txInfo)))
  where
  txInfo = scriptContextTxInfo ctx

-- Dead Pool contract
--  When we upgrade a pool, the liquidity moves into a new contract; These are owned by holders of the old liquidity token.
--  This script holds onto them and allows an exchange.
--  Parameterized by:
--    PoolCurrencySymbol, to identify the old liquidity token
--  Uses Datum:
--    new liquidity token symbol, identifier of the old pool, the exchange ratio, in case we change the liquidity formula
--  Allows (via Redeemer):
--    Exchange an old liquidity token for a new one
{-# inlinable deadPoolContract #-}
deadPoolContract :: PoolCurrencySymbol -> EscrowScriptHash -> DeadPoolDatum -> () -> ScriptContext -> Bool
deadPoolContract
  (PoolCurrencySymbol pcs)
  (EscrowScriptHash esh)
  datum@(DeadPoolDatum newPcs poolIdent oldToNewRatio) () ctx =
  debug "Pool nft not paid back out"
    (hasDeadPoolLimited pcs poolIdent (txOutValue ownOutput)) &&
  debug "Cannot include any escrows when spending dead pool"
    (not (atLeastOne (\i ->
      (txOutAddress $ txInInfoResolved i) == scriptHashAddress esh)
      (txInfoInputs txInfo))) &&
  debug "not disbursing the new liquidity tokens"
    (lostNewTrackingTokens == scaleInteger oldToNewRatio (PlutusTx.Numeric.negate burnedLiquidity)) &&
  debug "must only burn liquidity tokens"
    (onlyHas txInfoMint pcs liquidityTokenName (< 0)) &&
  debug "datum mismatch"
    (rawDatumOf txInfo ownOutput == Just (Datum $ toBuiltinData datum))
  where
  Just ownInput = findOwnInput ctx
  !ownOutput = uniqueElement' $ getContinuingOutputs ctx
  liquidityTokenName = computeLiquidityTokenName poolIdent
  burnedLiquidity = valueOf txInfoMint pcs liquidityTokenName
  lostNewTrackingTokens =
    valueOf (txOutValue $ txInInfoResolved ownInput) newPcs liquidityTokenName - valueOf (txOutValue ownOutput) newPcs liquidityTokenName
  txInfo@TxInfo{txInfoMint} = scriptContextTxInfo ctx

isFactory :: CurrencySymbol -> TxOut -> Bool
isFactory fbcs o = assetClassValueOf (txOutValue o) factoryNft == 1
  where
  factoryNft = assetClass fbcs factoryToken

{-# inlinable hasDeadPoolLimited #-}
-- | Dead pool value should contain pool NFT and no more than 3 items in the value:
-- Rider Ada, Liquidity, NFT
hasDeadPoolLimited :: CurrencySymbol -> BuiltinByteString -> Value -> Bool
hasDeadPoolLimited cs poolIdent val = hasLimitedNft 3 (toPoolNft cs poolIdent) val

-- Escrow contract
--  Lock user funds, with an order to execute against a pool
--  Parameterized by:
--    PoolCurrencySymbol, to identify the pool NFT allowed to spend the funds
--  Uses Datum:
--    Pool to execute against, A return destination, an alternate cancel address, what action to perform
--    Return destination can be either a wallet address, or a script address + datum hash
--  Allows (via Redeemer):
--    EscrowScoop - execute the order against a pool
--    EscrowCancel - cancel the order, returning the funds
{-# inlinable escrowContract #-}
escrowContract
  :: PoolCurrencySymbol
  -> EscrowDatum
  -> EscrowRedeemer
  -> ScriptContext
  -> Bool
escrowContract
  (PoolCurrencySymbol pcs)
  escrow_datum redeemer (ScriptContext tx_info _) =
    case redeemer of
      EscrowScoop ->
        escrowScoop
      EscrowCancel ->
        escrowCancel
  where
  escrowScoop =
    debug "no pool token output present"
      (atLeastOne (hasPoolToken . txOutValue) (txInfoOutputs $ tx_info))
    where
    !poolNft = toPoolNft pcs (_escrow'poolIdent escrow_datum)
    hasPoolToken :: Value -> Bool
    hasPoolToken o = assetClassValueOf o poolNft == 1

  escrowCancel =
    debug "the canceller did not sign the transaction"
      (atLeastOne (\x -> atLeastOne (\a -> a == x) (txInfoSignatories tx_info)) pkhs)
    where
    !(EscrowDatum _ escrow_addr _ _) = escrow_datum
    pkhs = escrowPubKeyHashes escrow_addr

data ScoopResult = ScoopResult
  { poolCons :: ![(EscrowDestination, ABL Integer)]
  , scoopResultA :: !Integer
  , scoopResultB :: !Integer
  , scoopResultLiquidity :: !Integer
  } deriving Prelude.Show

instance Pairlike () ScoopResult Integer where
  {-# inline conlike ofCoin #-}
  x `ofCoin` CoinA = ScoopResult [] x zero zero
  x `ofCoin` CoinB = ScoopResult [] zero x zero
  {-# inlinable ($$) #-}
  so $$ CoinA = scoopResultA so
  so $$ CoinB = scoopResultB so

{-# inlinable unsafeSqrt #-}
unsafeSqrt :: Rational -> Integer
unsafeSqrt !r = case rsqrt r of
  Exactly i -> i
  Approximately i -> i
  Imaginary -> error ()

-- Compute the result of processing one or more escrows against the pool. The
-- result is the same as if we processed each escrow in an independent
-- transaction
{-# inlinable doEscrows #-}
doEscrows
  :: SwapFees
  -> ABL Integer
  -> [(EscrowDestination, EscrowAction)]
  -> ScoopResult
doEscrows (SwapFees swapFees) !initialState !escrows =
  go (initialState $$ CoinA) (initialState $$ CoinB) (liquidity initialState) [] escrows
  where
  go !a !b !liq !cons ((ret,act):es) = case act of
    EscrowWithdraw givesLiquidity ->
      doWithdrawal ret givesLiquidity a b liq cons es
    EscrowSwap coin gives minTakes ->
      let
        !de = denominator swapFees
        !nu = numerator swapFees
        !diff = de - nu
      in
        case coin of
          CoinA
            | let !takes = (b * gives * diff) `divide` (a * de + gives * diff)
            , b > takes
            , Just takes >= minTakes ->
            go (a + gives) (b - takes) liq ((ret, takes `ofCoin` CoinB) : cons) es
          CoinB
            | let !takes = (a * gives * diff) `divide` (b * de + gives * diff)
            , a > takes
            , Just takes >= minTakes ->
            go (a - takes) (b + gives) liq ((ret, takes `ofCoin` CoinA) : cons) es
          _ -> error ()
    EscrowDeposit dep ->
      doDeposit ret dep a b liq cons es
  go a b liq cons [] = ScoopResult cons a b liq

  -- similar to the balancer formula
  doDeposit ret (DepositSingle coin amt) a b liq cons es =
    let
      de = denominator swapFees * 2
      nu = numerator swapFees
      diff = de - nu
      inPool CoinA = a
      inPool CoinB = b
      !liq2 = liq * liq
      !extraLiquidityTokens =
        unsafeSqrt
          (fromInteger liq2 + (liq2 * amt * diff) % (inPool coin * de)) -
        liq
      !liq_incr = liq + extraLiquidityTokens
      !liqABL = ofLiquidity extraLiquidityTokens
    in
      case coin of
        CoinA ->
          go (a + amt) b liq_incr ((ret, liqABL) : cons) es
        CoinB ->
          go a (b + amt) liq_incr ((ret, liqABL) : cons) es
  doDeposit ret (DepositMixed userGives) a b liq cons es =
    let !bInUnitsOfA = (userGives $$ CoinB * a) `divide` b
        !giveCoinA = userGives $$ CoinA
        !change =
          if bInUnitsOfA > giveCoinA then
            ((b * (bInUnitsOfA - giveCoinA)) `divide` a) `ofCoin` CoinB
          else
            (giveCoinA - bInUnitsOfA) `ofCoin` CoinA
        !userDeposits = noLiquidity (userGives - change)
        !extraLiquidityTokens = (userDeposits $$ CoinA * liq) `divide` a
        !output = ofLiquidity extraLiquidityTokens + noLiquidity change
    in
      go (a + userDeposits $$ CoinA) (b + userDeposits $$ CoinB) (liq + extraLiquidityTokens) ((ret, output) : cons) es

  doWithdrawal ret givesLiquidity a b liq cons es =
    let
      inPool CoinA = a
      inPool CoinB = b
      !withdrawn = noLiquidity $ memo \coin -> (givesLiquidity * inPool coin) `divide` liq
    in go (a - withdrawn $$ CoinA) (b - withdrawn $$ CoinB) (liq - givesLiquidity) ((ret, withdrawn) : cons) es
