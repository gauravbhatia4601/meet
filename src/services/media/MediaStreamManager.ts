/**
 * MediaStreamManager
 * 
 * Centralized media stream management to prevent:
 * - Excessive re-renders
 * - Device hanging from multiple stream initializations
 * - Stream cleanup issues
 * 
 * This is a singleton service that manages ONE stream instance
 * and only recreates it when necessary (device change, not state change)
 */

export class MediaStreamManager {
  private static instance: MediaStreamManager | null = null;
  private currentStream: MediaStream | null = null;
  private streamListeners: Set<(stream: MediaStream | null) => void> = new Set();

  private constructor() {
    // Private constructor for singleton
  }

  static getInstance(): MediaStreamManager {
    if (!MediaStreamManager.instance) {
      MediaStreamManager.instance = new MediaStreamManager();
    }
    return MediaStreamManager.instance;
  }

  /**
   * Get current stream (doesn't create if doesn't exist)
   */
  getStream(): MediaStream | null {
    return this.currentStream;
  }

  /**
   * Subscribe to stream changes
   */
  onStreamChange(callback: (stream: MediaStream | null) => void): () => void {
    this.streamListeners.add(callback);
    // Immediately call with current stream
    callback(this.currentStream);
    
    // Return unsubscribe function
    return () => {
      this.streamListeners.delete(callback);
    };
  }

  /**
   * Notify all listeners of stream change
   */
  private notifyListeners(): void {
    this.streamListeners.forEach(callback => {
      callback(this.currentStream);
    });
  }

  /**
   * Set stream (from external source, e.g., getUserMedia)
   * Only updates if stream actually changed
   */
  setStream(stream: MediaStream | null): void {
    if (this.currentStream === stream) {
      return; // No change, don't notify
    }

    // Stop old stream tracks if replacing
    if (this.currentStream && stream !== this.currentStream) {
      this.currentStream.getTracks().forEach(track => {
        track.stop();
        try {
          this.currentStream!.removeTrack(track);
        } catch (e) {
          // Track might already be removed
        }
      });
    }

    this.currentStream = stream;
    this.notifyListeners();
  }

  /**
   * Replace a track in the current stream
   * Prevents full stream recreation
   */
  replaceTrack(
    kind: 'audio' | 'video',
    newTrack: MediaStreamTrack,
    oldTrack?: MediaStreamTrack
  ): void {
    if (!this.currentStream) {
      // Create new stream if none exists
      this.currentStream = new MediaStream();
    }

    // Stop and remove old track
    if (oldTrack) {
      oldTrack.stop();
      try {
        this.currentStream.removeTrack(oldTrack);
      } catch (e) {
        // Track might already be removed
      }
    } else {
      // Remove all tracks of this kind
      const tracks = kind === 'audio' 
        ? this.currentStream.getAudioTracks()
        : this.currentStream.getVideoTracks();
      
      tracks.forEach(track => {
        track.stop();
        try {
          this.currentStream!.removeTrack(track);
        } catch (e) {
          // Track might already be removed
        }
      });
    }

    // Add new track
    this.currentStream.addTrack(newTrack);
    this.notifyListeners();
    
    console.log(`[MediaStreamManager] Replaced ${kind} track, new track ID: ${newTrack.id}, enabled: ${newTrack.enabled}, readyState: ${newTrack.readyState}`);
  }

  /**
   * Enable/disable tracks without recreating stream
   * If track is stopped (readyState === 'ended') or missing, returns false indicating need to recreate
   */
  setTrackEnabled(kind: 'audio' | 'video', enabled: boolean): boolean {
    if (!this.currentStream) {
      console.log(`[MediaStreamManager] No stream exists for ${kind}, enabled=${enabled}`);
      // No stream exists, can't enable/disable
      return !enabled; // Return true if disabling (nothing to do), false if enabling (need stream)
    }

    const tracks = kind === 'audio'
      ? this.currentStream.getAudioTracks()
      : this.currentStream.getVideoTracks();

    console.log(`[MediaStreamManager] setTrackEnabled ${kind}, enabled=${enabled}, tracks.length=${tracks.length}`);

    // If no tracks exist and we're trying to enable, need to recreate
    if (enabled && tracks.length === 0) {
      console.log(`[MediaStreamManager] No ${kind} tracks exist, need to recreate`);
      return false; // Signal that tracks need to be recreated
    }

    // Check track states
    const trackStates = tracks.map(t => ({ 
      id: t.id, 
      readyState: t.readyState, 
      enabled: t.enabled 
    }));
    console.log(`[MediaStreamManager] ${kind} track states:`, trackStates);

    // Check if any track is stopped (ended)
    const hasStoppedTracks = tracks.some(track => track.readyState === 'ended');
    
    // If we're trying to enable but tracks are stopped, we need to recreate them
    if (enabled && hasStoppedTracks) {
      console.log(`[MediaStreamManager] ${kind} tracks are stopped, need to recreate`);
      return false; // Signal that tracks need to be recreated
    }

    // If disabling, just disable (even if stopped, we can still try)
    if (!enabled) {
      tracks.forEach(track => {
        if (track.readyState === 'live') {
          track.enabled = false;
          console.log(`[MediaStreamManager] Disabled ${kind} track ${track.id}`);
        }
      });
      this.notifyListeners();
      return true;
    }

    // Enabling: make sure tracks are live before enabling
    const liveTracks = tracks.filter(track => track.readyState === 'live');
    
    if (liveTracks.length === 0 && tracks.length > 0) {
      // All tracks are stopped, need to recreate
      console.log(`[MediaStreamManager] All ${kind} tracks are stopped, need to recreate`);
      return false;
    }

    // Enable all live tracks
    liveTracks.forEach(track => {
      track.enabled = true;
      console.log(`[MediaStreamManager] Enabled ${kind} track ${track.id}`);
    });

    // Notify listeners that stream state changed
    this.notifyListeners();
    return true; // Successfully toggled
  }

  /**
   * Stop and clear current stream
   */
  stopStream(): void {
    if (this.currentStream) {
      this.currentStream.getTracks().forEach(track => {
        track.stop();
      });
    }
    this.setStream(null);
  }

  /**
   * Get stream tracks
   */
  getAudioTracks(): MediaStreamTrack[] {
    return this.currentStream?.getAudioTracks() || [];
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.currentStream?.getVideoTracks() || [];
  }

  /**
   * Check if stream has active tracks
   */
  hasAudio(): boolean {
    return this.getAudioTracks().length > 0 && this.getAudioTracks()[0].enabled;
  }

  hasVideo(): boolean {
    return this.getVideoTracks().length > 0 && this.getVideoTracks()[0].enabled;
  }

  /**
   * Cleanup (for testing or app shutdown)
   */
  destroy(): void {
    this.stopStream();
    this.streamListeners.clear();
    MediaStreamManager.instance = null;
  }
}

export const mediaStreamManager = MediaStreamManager.getInstance();


