import { useState, useCallback, useEffect, useRef } from 'react';
import type { WalletConnection, WalletType } from '../wallet/types';
import { isWalletRejection } from '../wallet/types';
import { connectWallet, disconnectWallet } from '../wallet/connect';
import { clearAllSessions } from '../auth/session';

/**
 * React hook for managing wallet connection lifecycle, handling rejections gracefully,
 * and enabling instant retries without requiring a page reload.
 *
 * Overlapping `connect()` calls are latest-call-wins: a call that has been
 * superseded never updates `wallet`, `loading`, `error`, or `isRejected`, though
 * its own promise still resolves or rejects with its original result.
 *
 * A call that settles after the component has unmounted resolves or rejects as
 * usual but leaves state alone, so no update reaches an unmounted component (#782).
 */
export function useWallet() {
  const [wallet, setWallet] = useState<WalletConnection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRejected, setIsRejected] = useState(false);
  const lastTypeRef = useRef<WalletType>('freighter');
  const callIdRef = useRef(0);
  // Starts `true` so a connect started from a child's effect (which runs before
  // this hook's effect) is not treated as unmounted.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reset = useCallback(() => {
    setError(null);
    setIsRejected(false);
  }, []);

  const connect = useCallback(async (type: WalletType = 'freighter') => {
    const callId = ++callIdRef.current;
    // Only the newest call, while still mounted, may touch state once it settles.
    const isCurrent = () => mountedRef.current && callId === callIdRef.current;
    lastTypeRef.current = type;
    setLoading(true);
    setError(null);
    setIsRejected(false);
    try {
      const w = await connectWallet(type);
      if (isCurrent()) {
        setWallet(w);
        setIsRejected(false);
      }
      return w;
    } catch (e: unknown) {
      if (isCurrent()) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        if (isWalletRejection(e)) {
          setIsRejected(true);
        }
      }
      throw e;
    } finally {
      if (isCurrent()) {
        setLoading(false);
      }
    }
  }, []);

  const retry = useCallback(async () => {
    return connect(lastTypeRef.current);
  }, [connect]);

  const disconnect = useCallback(async () => {
    try {
      await disconnectWallet();
    } finally {
      // Revoke cached auth state even when the wallet-level disconnect
      // rejects: stored JWTs, refresh tokens, and challenge nonces must not
      // outlive the connection they belonged to (#347), so a later
      // reconnect has to re-sign the challenge instead of reusing them.
      clearAllSessions();
      if (mountedRef.current) {
        setWallet(null);
        setError(null);
        setIsRejected(false);
      }
    }
  }, []);

  return {
    wallet,
    loading,
    error,
    isRejected,
    connect,
    retry,
    reset,
    disconnect,
    isConnected: !!wallet,
  };
}
