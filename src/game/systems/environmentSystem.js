export class EnvironmentSystem {
  /**
   * @param {import('../../game.js').Game} game
   */
  constructor(game) {
    this.game = game;
  }

  /**
   * @param {number} dtSec
   * @param {number} nowSec
   */
  update(dtSec, nowSec) {
    void dtSec;
    void nowSec;
    const g = this.game;
    this.updateObjectRotation();
    this.updateSpaceDust();
  }

  updateObjectRotation() {
    const g = this.game;
    for (const obj of g.objects) {
      if (obj.userData.rotationSpeed) {
        obj.rotation.x += obj.userData.rotationSpeed.x;
        obj.rotation.y += obj.userData.rotationSpeed.y;
        obj.rotation.z += obj.userData.rotationSpeed.z;
      } else if (obj.userData.type === 'planet') {
        obj.rotation.y += 0.001;
      }
    }
  }

  updateSpaceDust() {
    const g = this.game;
    if (!g.spaceDustPoints || !g.player) return;

    const positions = g.spaceDustPoints.geometry.attributes.position.array;
    const range = 200;
    let needsUpdate = false;

    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i] < g.player.position.x - range) {
        positions[i] += range * 2;
        needsUpdate = true;
      } else if (positions[i] > g.player.position.x + range) {
        positions[i] -= range * 2;
        needsUpdate = true;
      }

      if (positions[i + 1] < g.player.position.y - range) {
        positions[i + 1] += range * 2;
        needsUpdate = true;
      } else if (positions[i + 1] > g.player.position.y + range) {
        positions[i + 1] -= range * 2;
        needsUpdate = true;
      }

      if (positions[i + 2] < g.player.position.z - range) {
        positions[i + 2] += range * 2;
        needsUpdate = true;
      } else if (positions[i + 2] > g.player.position.z + range) {
        positions[i + 2] -= range * 2;
        needsUpdate = true;
      }
    }

    if (needsUpdate) g.spaceDustPoints.geometry.attributes.position.needsUpdate = true;
  }
}

